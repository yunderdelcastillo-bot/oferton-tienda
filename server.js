require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const OpenAI = require('openai');
const { z } = require('zod');
const { suggestRegularPrice } = require('./lib/rules');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC_UPLOADS = path.join(ROOT, 'public', 'uploads');
const PRIVATE_UPLOADS = path.join(ROOT, 'private_uploads');
for (const p of [DATA, PUBLIC_UPLOADS, PRIVATE_UPLOADS]) fs.mkdirSync(p, { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn('ADVERTENCIA: configura SESSION_SECRET con al menos 32 caracteres en .env');
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.includes('CAMBIA-ESTA')) {
  console.warn('ADVERTENCIA: configura ADMIN_PASSWORD antes de publicar la tienda.');
}
const db = new Database(path.join(DATA, 'oferton.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL DEFAULT 'General', tags TEXT NOT NULL DEFAULT '[]', image TEXT NOT NULL DEFAULT '',
 offer_price INTEGER NOT NULL CHECK(offer_price >= 0), regular_price INTEGER NOT NULL CHECK(regular_price >= 0),
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0,
 variants TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, access_token TEXT UNIQUE NOT NULL,
 customer_json TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL,
 payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'PAGO PENDIENTE DE VERIFICACIÓN',
 status TEXT NOT NULL DEFAULT 'Pedido recibido', proof_file TEXT, operation_no TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
`);
const settingDefaults = {
 store_name: 'OFERTÓN', tagline: 'Ofertas que te encantarán', accent: '#e34b38', whatsapp: '',
 yape_number: '', yape_holder: '', yape_instructions: 'Yapea el importe exacto y adjunta tu comprobante. El pago será verificado manualmente antes de confirmarse.',
 yape_enabled: '1', yape_qr: '', shipping_flat: '0', assistant_enabled: '1', logo: '', banner_title: 'Encuentra tu próxima oferta', banner_text: 'Compra fácil, rápido y desde donde estés.'
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
Object.entries(settingDefaults).forEach(([k,v]) => insertSetting.run(k,v));
const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value]));
const setSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const slugify = s => String(s||'producto').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'producto';
const money = n => Math.round(Number(n)*100);
const asSoles = n => Number(n)/100;
const safeEqual = (a,b) => { const x=Buffer.from(String(a)); const y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); };

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"], imgSrc:["'self'",'data:','blob:'], connectSrc:["'self'"], objectSrc:["'none'"], upgradeInsecureRequests: null }}}));
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false,limit:'1mb'}));
app.use(session({ name:'oferton.sid', secret:process.env.SESSION_SECRET || 'dev-only-change-this-secret-please-123456', resave:false, saveUninitialized:false, store:new SQLiteStore({db:'sessions.sqlite',dir:DATA}), cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000} }));
app.use('/api/login', rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false}));
app.use('/api/recover-password', rateLimit({windowMs:15*60*1000,limit:5,standardHeaders:true,legacyHeaders:false}));
app.use(express.static(path.join(ROOT,'public'), {extensions:['html']}));
const requireAdmin = (req,res,next) => { if (!req.session?.admin) return res.status(401).json({error:'Debes iniciar sesión como administrador.'}); if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'Origen no autorizado.'}); next(); };
const uploadImage = multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,PUBLIC_UPLOADS),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
const uploadPrivate = multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,PRIVATE_UPLOADS),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:6*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype))});

// Inicializa una sola cuenta administrativa a partir de variables de entorno.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD.includes('CAMBIA-ESTA')) {
 const exists=db.prepare('SELECT id FROM admin_users WHERE username=?').get(process.env.ADMIN_USERNAME);
 if (!exists) db.prepare('INSERT INTO admin_users(username,password_hash) VALUES(?,?)').run(process.env.ADMIN_USERNAME,bcrypt.hashSync(process.env.ADMIN_PASSWORD,12));
}
app.get('/api/public/settings',(req,res)=>{ const s=getSettings(); res.json({store_name:s.store_name,tagline:s.tagline,accent:s.accent,whatsapp:s.whatsapp,yape_enabled:s.yape_enabled==='1',banner_title:s.banner_title,banner_text:s.banner_text,logo:s.logo}); });
app.get('/api/products',(req,res)=>res.json(db.prepare('SELECT id,slug,name,description,category,tags,image,offer_price,regular_price,stock,featured,variants FROM products WHERE active=1 ORDER BY featured DESC,id DESC').all().map(p=>({...p,offer_price:asSoles(p.offer_price),regular_price:asSoles(p.regular_price),tags:JSON.parse(p.tags),variants:JSON.parse(p.variants)}))));
app.get('/api/products/:slug',(req,res)=>{const p=db.prepare('SELECT * FROM products WHERE slug=? AND active=1').get(req.params.slug); if(!p)return res.status(404).json({error:'Producto no encontrado'});res.json({...p,offer_price:asSoles(p.offer_price),regular_price:asSoles(p.regular_price),tags:JSON.parse(p.tags),variants:JSON.parse(p.variants)});});
app.post('/api/recover-password',async(req,res)=>{
 const recoveryCode=String(req.body?.recoveryCode||'');
 const next=String(req.body?.newPassword||'');
 const configured=String(process.env.ADMIN_RECOVERY_CODE||'');
 if(!configured||configured.length<24)return res.status(503).json({error:'La recuperación no está configurada. Contacta al administrador del servicio.'});
 if(!safeEqual(recoveryCode,configured))return res.status(401).json({error:'Código de recuperación incorrecto.'});
 if(next.length<12||next.length>200)return res.status(400).json({error:'La nueva contraseña debe tener entre 12 y 200 caracteres.'});
 const username=String(process.env.ADMIN_USERNAME||'');
 const user=db.prepare('SELECT id FROM admin_users WHERE username=?').get(username);
 if(!user)return res.status(503).json({error:'No se encontró la cuenta administradora configurada.'});
 db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(await bcrypt.hash(next,12),user.id);
 res.json({ok:true,message:'Contraseña restablecida. Ya puedes iniciar sesión.'});
});
app.post('/api/login',async(req,res)=>{const {username,password}=req.body||{};const u=db.prepare('SELECT * FROM admin_users WHERE username=?').get(String(username||''));if(!u || !await bcrypt.compare(String(password||''),u.password_hash))return res.status(401).json({error:'Usuario o contraseña incorrectos.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'No se pudo iniciar sesión.'});req.session.admin={id:u.id,username:u.username};res.json({ok:true,username:u.username});});});
app.post('/api/logout',requireAdmin,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({username:req.session.admin.username}));
app.post('/api/admin/change-password',requireAdmin,async(req,res)=>{
 const current=String(req.body?.currentPassword||'');
 const next=String(req.body?.newPassword||'');
 if(next.length<12||next.length>200)return res.status(400).json({error:'La nueva contraseña debe tener entre 12 y 200 caracteres.'});
 const user=db.prepare('SELECT id,password_hash FROM admin_users WHERE id=?').get(req.session.admin.id);
 if(!user||!await bcrypt.compare(current,user.password_hash))return res.status(401).json({error:'La contraseña actual es incorrecta.'});
 if(await bcrypt.compare(next,user.password_hash))return res.status(400).json({error:'La nueva contraseña debe ser diferente.'});
 db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(await bcrypt.hash(next,12),user.id);
 res.json({ok:true,message:'Contraseña actualizada correctamente.'});
});
app.get('/api/admin/settings',requireAdmin,(req,res)=>res.json(getSettings()));
app.post('/api/admin/settings',requireAdmin,uploadImage.fields([{name:'logo',maxCount:1},{name:'yape_qr',maxCount:1}]),(req,res)=>{
 const allowed=['store_name','tagline','accent','whatsapp','yape_number','yape_holder','yape_instructions','yape_enabled','shipping_flat','assistant_enabled','banner_title','banner_text'];
 for(const k of allowed) if(req.body[k]!==undefined)setSetting.run(k,String(req.body[k]).slice(0,3000));
 if(req.files?.logo?.[0])setSetting.run('logo','/uploads/'+req.files.logo[0].filename);
 if(req.files?.yape_qr?.[0])setSetting.run('yape_qr','/uploads/'+req.files.yape_qr[0].filename);
 res.json({ok:true,settings:getSettings()});
});
const productSchema=z.object({name:z.string().trim().min(2).max(160),description:z.string().max(4000).optional().default(''),category:z.string().max(80).optional().default('General'),tags:z.array(z.string().max(40)).max(20).optional().default([]),offer_price:z.coerce.number().positive().max(1000000),regular_price:z.coerce.number().positive().max(1000000).optional(),stock:z.coerce.number().int().min(0).max(1000000),image:z.string().max(500).optional().default(''),active:z.coerce.boolean().optional().default(true),featured:z.coerce.boolean().optional().default(false),variants:z.array(z.object({name:z.string().max(80),options:z.array(z.string().max(80)).max(40)})).optional().default([])});
app.get('/api/admin/products',requireAdmin,(req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(p=>({...p,offer_price:asSoles(p.offer_price),regular_price:asSoles(p.regular_price),tags:JSON.parse(p.tags),variants:JSON.parse(p.variants)}))));
app.post('/api/admin/products',requireAdmin,async(req,res)=>{const parsed=productSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Revisa los datos del producto.',details:parsed.error.flatten()});const p=parsed.data;const offer=money(p.offer_price);const regular=money(p.regular_price||suggestRegularPrice(p.offer_price));let slug=slugify(p.name);if(db.prepare('SELECT id FROM products WHERE slug=?').get(slug))slug+='-'+crypto.randomBytes(3).toString('hex');const info=db.prepare('INSERT INTO products(slug,name,description,category,tags,image,offer_price,regular_price,stock,active,featured,variants) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(slug,p.name,p.description,p.category,JSON.stringify(p.tags),p.image,offer,regular,p.stock,p.active?1:0,p.featured?1:0,JSON.stringify(p.variants));res.json({ok:true,id:info.lastInsertRowid,slug});});
app.put('/api/admin/products/:id',requireAdmin,(req,res)=>{const parsed=productSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Datos de producto inválidos.'});const p=parsed.data;const offer=money(p.offer_price);const regular=money(p.regular_price||suggestRegularPrice(p.offer_price));const r=db.prepare('UPDATE products SET name=?,description=?,category=?,tags=?,image=?,offer_price=?,regular_price=?,stock=?,active=?,featured=?,variants=? WHERE id=?').run(p.name,p.description,p.category,JSON.stringify(p.tags),p.image,offer,regular,p.stock,p.active?1:0,p.featured?1:0,JSON.stringify(p.variants),req.params.id);if(!r.changes)return res.status(404).json({error:'Producto no encontrado.'});res.json({ok:true});});
app.delete('/api/admin/products/:id',requireAdmin,(req,res)=>{const r=db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);res.json({ok:!!r.changes});});
app.post('/api/admin/upload',requireAdmin,uploadImage.single('image'),(req,res)=>{if(!req.file)return res.status(400).json({error:'Sube JPG, PNG o WEBP de hasta 5 MB.'});res.json({url:'/uploads/'+req.file.filename});});
app.post('/api/admin/ai-product',requireAdmin,uploadImage.single('image'),async(req,res)=>{if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'Falta OPENAI_API_KEY en .env. Puedes crear el producto manualmente.'});if(!req.file)return res.status(400).json({error:'Adjunta una fotografía del producto.'});try{const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});const b64=fs.readFileSync(req.file.path).toString('base64');const response=await client.chat.completions.create({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',response_format:{type:'json_object'},messages:[{role:'system',content:'Eres asistente de catálogo. Analiza solo lo visible; no inventes marca, materiales, medidas, certificaciones ni prestaciones. Devuelve JSON con name, description, category, tags (array), ad_copy. Responde en español.'},{role:'user',content:[{type:'text',text:'Propón una ficha comercial prudente para este producto. Señala la incertidumbre en vez de inventar datos.'},{type:'image_url',image_url:{url:`data:${req.file.mimetype};base64,${b64}`,detail:'high'}}]}],max_tokens:700});const suggestion=JSON.parse(response.choices[0].message.content);res.json({ok:true,suggestion,image:'/uploads/'+req.file.filename});}catch(e){console.error('OpenAI product error',e.message);res.status(502).json({error:'La IA no respondió. Intenta de nuevo o crea el producto manualmente.'});}});

const customerSchema=z.object({firstName:z.string().trim().min(2).max(100),lastName:z.string().trim().min(2).max(100),documentType:z.enum(['DNI','CE','Pasaporte']).default('DNI'),documentNumber:z.string().trim().min(5).max(20),phone:z.string().trim().min(7).max(25),email:z.string().trim().email().max(160).optional().or(z.literal('')),department:z.string().trim().min(2).max(80),province:z.string().trim().min(2).max(80),district:z.string().trim().min(2).max(80),address:z.string().trim().min(5).max(300),reference:z.string().max(300).optional().default(''),delivery:z.enum(['Domicilio','Agencia de transporte','Coordinar por WhatsApp']),paymentMethod:z.enum(['Yape','Contraentrega']),notes:z.string().max(1000).optional().default('')});
app.post('/api/orders',async(req,res)=>{const parsed=customerSchema.safeParse(req.body.customer);if(!parsed.success)return res.status(400).json({error:'Completa correctamente los datos de contacto y entrega.'});const customer=parsed.data;const cart=req.body.items;if(!Array.isArray(cart)||!cart.length||cart.length>50)return res.status(400).json({error:'El carrito está vacío o contiene demasiados artículos.'});const s=getSettings();if(customer.paymentMethod==='Yape'&&s.yape_enabled!=='1')return res.status(400).json({error:'Yape está temporalmente desactivado.'});const tx=db.transaction(()=>{let subtotal=0;const lines=[];for(const line of cart){const id=Number(line.id),qty=Number(line.quantity);if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>100)throw new Error('Producto o cantidad inválidos.');const p=db.prepare('SELECT id,name,slug,offer_price,stock,active,image FROM products WHERE id=?').get(id);if(!p||!p.active)throw new Error('Uno de los productos ya no está disponible.');if(p.stock<qty)throw new Error(`Stock insuficiente para ${p.name}.`);subtotal+=p.offer_price*qty;lines.push({id:p.id,name:p.name,slug:p.slug,image:p.image,unitPrice:asSoles(p.offer_price),quantity:qty,lineTotal:asSoles(p.offer_price*qty)});}const shipping=customer.delivery==='Domicilio'?money(Number(s.shipping_flat||0)):0;const total=subtotal+shipping;const orderNo='OF-'+new Date().toISOString().slice(2,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();const token=crypto.randomBytes(32).toString('hex');const status=customer.paymentMethod==='Yape'?'Pago pendiente':'Pedido recibido';const paymentStatus=customer.paymentMethod==='Yape'?'PAGO PENDIENTE DE VERIFICACIÓN':'Pago contraentrega por coordinar';const info=db.prepare('INSERT INTO orders(order_no,access_token,customer_json,items_json,subtotal,shipping,total,payment_method,payment_status,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(orderNo,token,JSON.stringify(customer),JSON.stringify(lines),subtotal,shipping,total,customer.paymentMethod,paymentStatus,status,customer.notes);for(const line of lines)db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(line.quantity,line.id);return {orderNo,token,id:info.lastInsertRowid,total:asSoles(total),lines,shipping:asSoles(shipping)};});try{const order=tx();res.status(201).json({...order,trackingUrl:`/pedido.html?token=${order.token}`,payment:{method:customer.paymentMethod,number:s.yape_number,holder:s.yape_holder,qr:s.yape_qr,instructions:s.yape_instructions}});}catch(e){res.status(400).json({error:e.message||'No se pudo registrar el pedido.'});}});
app.post('/api/orders/:token/proof',uploadPrivate.single('proof'),(req,res)=>{const order=db.prepare('SELECT * FROM orders WHERE access_token=?').get(req.params.token);if(!order)return res.status(404).json({error:'Pedido no encontrado.'});if(order.payment_method!=='Yape')return res.status(400).json({error:'Este pedido no usa Yape.'});if(!req.file)return res.status(400).json({error:'Adjunta una imagen o PDF de hasta 6 MB.'});const op=String(req.body.operation_no||'').slice(0,80);db.prepare("UPDATE orders SET proof_file=?,operation_no=?,payment_status='PAGO PENDIENTE DE VERIFICACIÓN',status='Comprobante enviado' WHERE id=?").run(req.file.filename,op,order.id);res.json({ok:true,message:'Comprobante recibido. El pago sigue pendiente de verificación real.'});});
app.get('/api/orders/:token',(req,res)=>{const o=db.prepare('SELECT order_no,access_token,customer_json,items_json,subtotal,shipping,total,payment_method,payment_status,status,operation_no,created_at FROM orders WHERE access_token=?').get(req.params.token);if(!o)return res.status(404).json({error:'Pedido no encontrado.'});const c=JSON.parse(o.customer_json);const customer={firstName:c.firstName,lastName:c.lastName,department:c.department,province:c.province,district:c.district,address:c.address,delivery:c.delivery};res.json({...o,customer,items:JSON.parse(o.items_json),subtotal:asSoles(o.subtotal),shipping:asSoles(o.shipping),total:asSoles(o.total),access_token:undefined});});
app.get('/api/admin/orders',requireAdmin,(req,res)=>res.json(db.prepare('SELECT id,order_no,customer_json,items_json,subtotal,shipping,total,payment_method,payment_status,status,operation_no,proof_file,created_at FROM orders ORDER BY id DESC').all().map(o=>({...o,customer:JSON.parse(o.customer_json),items:JSON.parse(o.items_json),subtotal:asSoles(o.subtotal),shipping:asSoles(o.shipping),total:asSoles(o.total)}))));
app.get('/api/admin/orders/:id/proof',requireAdmin,(req,res)=>{const o=db.prepare('SELECT proof_file FROM orders WHERE id=?').get(req.params.id);if(!o?.proof_file)return res.status(404).send('Comprobante no encontrado');const p=path.join(PRIVATE_UPLOADS,path.basename(o.proof_file));if(!fs.existsSync(p))return res.status(404).send('Archivo no encontrado');res.sendFile(p);});
app.patch('/api/admin/orders/:id',requireAdmin,(req,res)=>{const allowed=['Pedido recibido','Pago pendiente','Comprobante enviado','Pago en revisión','Pago confirmado','Preparando pedido','Pedido enviado','Pedido entregado','Pedido cancelado'];if(!allowed.includes(req.body.status))return res.status(400).json({error:'Estado no válido.'});const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'Pedido no encontrado.'});if(o.status==='Pedido cancelado'&&req.body.status!=='Pedido cancelado')return res.status(400).json({error:'Un pedido cancelado no se puede reactivar desde este panel.'});if(req.body.status==='Pago confirmado'&&o.payment_method==='Yape'&&!['Comprobante enviado','Pago en revisión','Pago confirmado'].includes(o.status))return res.status(400).json({error:'Revisa el comprobante y verifica el abono real antes de confirmar.'});const pay=req.body.status==='Pago confirmado'?'PAGO CONFIRMADO':o.payment_status;const tx=db.transaction(()=>{if(req.body.status==='Pedido cancelado'&&o.status!=='Pedido cancelado'){for(const item of JSON.parse(o.items_json))db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.id);}db.prepare('UPDATE orders SET status=?,payment_status=? WHERE id=?').run(req.body.status,pay,o.id);});tx();res.json({ok:true});});
app.get('/api/admin/stats',requireAdmin,(req,res)=>{res.json({products:db.prepare('SELECT count(*) n FROM products').get().n,orders:db.prepare('SELECT count(*) n FROM orders').get().n,pending:db.prepare("SELECT count(*) n FROM orders WHERE payment_status LIKE '%PENDIENTE%' OR status='Pago en revisión'").get().n,sales:asSoles(db.prepare("SELECT COALESCE(sum(total),0) n FROM orders WHERE payment_status='PAGO CONFIRMADO'").get().n)});});
app.post('/api/assistant',async(req,res)=>{const s=getSettings();if(s.assistant_enabled!=='1')return res.status(503).json({error:'El asistente está desactivado.'});if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'El asistente requiere configurar OPENAI_API_KEY.'});const question=String(req.body.question||'').slice(0,1200);if(!question.trim())return res.status(400).json({error:'Escribe una pregunta.'});const products=db.prepare('SELECT name,description,category,offer_price,stock FROM products WHERE active=1').all().map(p=>({...p,offer_price:asSoles(p.offer_price)}));const settings=getSettings();try{const ai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});const r=await ai.chat.completions.create({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',messages:[{role:'system',content:`Eres asistente de la tienda ${settings.store_name}. Responde en español basándote solo en el catálogo/configuración suministrados. No inventes disponibilidad ni confirmes pagos. Deriva casos especiales a WhatsApp ${settings.whatsapp||'(número aún no configurado)'}. Catálogo: ${JSON.stringify(products)}. Instrucciones Yape: ${settings.yape_instructions}. Envío domicilio: S/${settings.shipping_flat}.`},{role:'user',content:question}],max_tokens:350});res.json({answer:r.choices[0].message.content});}catch(e){res.status(502).json({error:'El asistente no está disponible ahora.'});}});
app.get('/api/health',(req,res)=>res.json({ok:true,app:'OFERTÓN'}));
app.use((err,req,res,next)=>{console.error(err);if(err instanceof multer.MulterError)return res.status(400).json({error:'Archivo demasiado grande o no válido.'});res.status(500).json({error:'Ocurrió un error interno.'});});
app.listen(PORT,()=>console.log(`OFERTÓN listo en ${process.env.BASE_URL||`http://localhost:${PORT}`}`));
