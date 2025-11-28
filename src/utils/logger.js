const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'whatsapp-bot' },
    transports: [
        // Logs de error
        new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error' 
        }),
        // Todos los logs
        new winston.transports.File({ 
            filename: 'logs/combined.log' 
        })
    ]
});

// Si no estamos en producción, también log a consola
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
} else {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

module.exports = logger;