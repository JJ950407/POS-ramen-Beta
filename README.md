# DEKU RAMEN POS

Este proyecto recrea un POS completo con backend, WebSocket, kitchen display y waiter app sin dependencias externas.

## Cómo ejecutar

```bash
npm install
npm run start
```

Luego abre:
- `http://localhost:3000/waiter-app.html`
- `http://localhost:3000/kitchen-display.html`

## Notas

- Puedes agregar tu logo luego en `/assets` y reemplazar el header por una imagen.
- El sistema mantiene el flujo de órdenes en tiempo real mediante WebSocket.

## Estructura

```
.
├── public
│   ├── assets
│   ├── kitchen-display.html
│   ├── waiter-app.html
│   ├── index.html
│   └── styles.css
├── server.js
└── package.json
```
