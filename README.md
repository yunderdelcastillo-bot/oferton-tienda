# OFERTÓN — proyecto nuevo desde cero

Aplicación Node.js + Express + SQLite para una tienda virtual. Incluye catálogo adaptable, carrito, formulario de comprador/entrega, pedido con enlace privado, panel administrativo, productos con precio de oferta y precio normal sugerido, carga de QR Yape, carga privada de comprobantes, estados de pedidos, WhatsApp mediante enlaces y endpoints opcionales de OpenAI.

## Requisitos
- Node.js 20 o superior y npm.
- Para usar generación de fichas/asistente con IA: una clave de API de OpenAI con facturación habilitada.
- Para publicar: un VPS/servidor con HTTPS y disco persistente. Esta versión guarda SQLite y archivos localmente; **no debe desplegarse en un alojamiento efímero/serverless** sin migrar la base de datos a PostgreSQL y archivos a almacenamiento de objetos privado.

## Instalar en tu computadora
1. Descomprime el ZIP.
2. Entra a la carpeta `oferton-desde-cero`.
3. Copia `.env.example` como `.env`.
4. Cambia `SESSION_SECRET` por una cadena aleatoria larga, `ADMIN_USERNAME` y `ADMIN_PASSWORD` por credenciales propias. No publiques ni compartas `.env`.
5. Opcional: agrega tu `OPENAI_API_KEY` y revisa `OPENAI_MODEL`.
6. Ejecuta `npm install`.
7. Ejecuta `npm start`.
8. Abre `http://localhost:3000`. Panel privado: `http://localhost:3000/admin.html`.

La cuenta de administración se crea desde las variables de entorno al iniciar por primera vez si no existe. Si cambias el usuario después de haber creado la cuenta, no se crea automáticamente otra cuenta; para una rotación de credenciales se requiere procedimiento de administración de usuarios.

## Datos del comprador
El formulario recoge nombres, apellidos, tipo y número de documento, teléfono, correo opcional, departamento, provincia, distrito, dirección completa, referencia, método de entrega, método de pago e indicaciones. Departamento/provincia/distrito se ingresan en campos separados; no se consulta aún un padrón oficial de ubigeos ni hay desplegables encadenados.

## Yape y comprobantes
En el panel, pestaña “Diseño y pagos”, configura el número, titular, QR e instrucciones. Los comprobantes se almacenan en `private_uploads/` y solo se sirven mediante una ruta administrativa autenticada. El cliente obtiene un enlace de seguimiento con token aleatorio. Adjuntar un comprobante **no** confirma el pago; la confirmación debe hacerla el administrador después de comprobar el abono real en Yape. No hay integración directa de verificación automática con Yape.

## OpenAI
La clave se lee exclusivamente desde `OPENAI_API_KEY` en el servidor. El análisis fotográfico propone nombre, descripción, categoría y etiquetas; el administrador debe revisar y guardar. Si no hay clave, el producto puede crearse manualmente. El asistente se limita al catálogo actual y a los ajustes de la tienda.

## Precios y stock
El servidor vuelve a consultar precio y stock al crear un pedido, y descuenta el stock dentro de una transacción. La regla inicial propone precio normal = precio de oferta × 1.20. El precio normal se muestra como sugerido, no como precio histórico probado. La moneda es PEN / soles.

## Publicación
Para una primera publicación real, utiliza un VPS con disco persistente, Node.js 20+, dominio y certificado HTTPS. Configura `NODE_ENV=production`, `BASE_URL=https://tu-dominio`, un `SESSION_SECRET` aleatorio y credenciales seguras. Usa un proxy HTTPS que reenvíe `X-Forwarded-Proto` y configura Express `trust proxy` antes de activar cookies seguras (la configuración actual requiere revisarse según el proxy elegido). Restringe permisos de `data/`, `private_uploads/` y haz copias de seguridad cifradas de SQLite y archivos. Nunca hagas público el directorio `private_uploads/` ni el `.env`.

## Funciones que todavía requieren integración/fortalecimiento antes de aceptar público general
- Migrar SQLite y archivos locales a PostgreSQL + almacenamiento privado duradero para despliegues multiinstancia.
- Implementar CSRF tokens y política de origen estricta, rotación y recuperación de contraseñas, 2FA, auditoría y límites adicionales.
- Configurar correo transaccional/notificaciones de pedido.
- Configurar WhatsApp Business Platform si se quieren mensajes automáticos. Los botones actuales abren WhatsApp con un texto preparado; el cliente debe enviarlo.
- Integración de pago autorizada para verificación automática, si el proveedor la ofrece.
- Catálogo oficial de departamentos/provincias/distritos (ubigeo), variantes que alteren precio/stock y reglas de envío por zona.
- Política de privacidad y condiciones de compra revisadas para el negocio y la normativa aplicable.
- Añadir pruebas de integración en un entorno real, restauración de backups y escaneo de seguridad antes de producción.

## Pruebas rápidas
- `npm test` ejecuta pruebas unitarias de las reglas de precio y stock.
- `GET /api/health` verifica que el servidor está arriba.
- Comprueba el panel, producto, pedido y comprobante manualmente en local.
