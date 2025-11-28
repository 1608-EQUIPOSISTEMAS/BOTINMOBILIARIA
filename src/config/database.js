const mysql = require('mysql2/promise');
const config = require('./config');

// Pool de conexiones para roles y permisos
const poolRoles = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Verificar conexión
poolRoles.getConnection()
    .then(connection => {
        console.log('✅ Conexión a BD de Roles exitosa');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Error conectando a BD de Roles:', err.message);
    });

module.exports = poolRoles;