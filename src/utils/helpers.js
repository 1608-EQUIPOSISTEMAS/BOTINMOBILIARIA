/**
 * Espera un tiempo determinado (sleep)
 * @param {number} ms - Milisegundos a esperar
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Formatea un número de teléfono
 * @param {string} phone - Número de teléfono
 * @returns {string}
 */
function formatPhone(phone) {
    return phone.replace(/[^\d]/g, '');
}

/**
 * Reemplaza variables en el contenido del mensaje
 * @param {string} content - Contenido del mensaje
 * @param {object} variables - {nombre: 'Juan', etc}
 * @returns {string}
 */
function replaceVariables(content, variables) {
    if (!content) return content;
    
    let result = content;
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{${key}\\}`, 'gi');
        result = result.replace(regex, value);
    }
    return result;
}

/**
 * Valida si una URL es válida
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    sleep,
    formatPhone,
    replaceVariables,
    isValidUrl
};