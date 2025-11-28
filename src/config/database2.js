const mysql = require('mysql2/promise');
const config2 = require('./config2');

// Pool de conexiones para inmobiliaria
const poolInmobiliaria = mysql.createPool({
    host: config2.database.host,
    port: config2.database.port,
    user: config2.database.user,
    password: config2.database.password,
    database: config2.database.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Verificar conexión
poolInmobiliaria.getConnection()
    .then(connection => {
        console.log('✅ Conexión a BD de Inmobiliaria exitosa');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Error conectando a BD de Inmobiliaria:', err.message);
    });

module.exports = poolInmobiliaria;