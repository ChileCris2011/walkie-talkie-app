# Walkie Talkie App (Testing)

Ésta es una aplicación Walkie-Talkie multi plataforma (Android, IOS, Web) basada en react.  

  
Advertencia: La rama `testing` es usada para hacer diversos testeos de nuevas funcionalidades. Si quieres colaborar, puedes usar ésta rama **a tu propio riesgo**, enviando tus sugerencias a través de [issues](https://github.com/ChileCris2011/walkie-talkie-app/issues/new?labels=development).  
Si quieres la última versión estable, usa la rama [secure](https://github.com/ChileCris2011/walkie-talkie-app/tree/secure) o usa el código fuente de los [releases](https://github.com/ChileCris2011/walkie-talkie-app/releases)

## Cómo usar

### Desarrollo y pruebas

La aplicación aún no ha sido lanzada, así que los pasos siguientes son para construir la aplicación

1. Instala las dependencias

   ```bash
   npm install
   ```

2. Inicia la aplicación
   
   2.1 Inicia el servidor  
   La aplicación necesita de un servidor (backend) para poder manejar las solicitudes y audio. Puedes iniciar uno local con el proyecto [Walkie Server](https://github.com/ChileCris2011/Walkie-Server/) de mi GitHub, o usar el servidor público de Render
   ```text
   https://walkie-server-ov27.onrender.com
   ```
   editando `/app/index.tsx` en:
   ```tsx
   24| const SERVER_URL = 'https://localhost:3000'; // Por defecto
   ```
   
   2.2. Inicia la aplicación expo
   ```bash
   npx expo start
   ```
   Para android, escanea el QR de la consola con Expo Go, para IOS escanea el QR de la consola con la cámara, para web, sigue el enlace de la consola (por defecto `http://localhost:8081/`)
3. ¡Disfruta la aplicación!
