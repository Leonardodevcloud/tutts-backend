const PrivateKey = require('starkbank-ecdsa').PrivateKey;


function formatDate(date) {
    let d = new Date(date),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear();

    if (month.length < 2)
        month = '0'+ month;
    if (day.length < 2)
        day = '0'+ day;

    return [year, month, day].join('-');
};

function formatDatetime(datetime) {
    return datetime.toISOString().replace('Z', '+00:00');
};

exports.environment = function (environment){
    let validEnvironment = ['production', 'sandbox'];
    if(validEnvironment.includes(environment)){
        return environment;
    }
    throw Error(`Select a valid environment: ${validEnvironment}`);
};

exports.key = function (key){
    try {
        PrivateKey.fromPem(key);
    } catch (e) {
        throw new Error('Private-key must be valid secp256k1 ECDSA string in pem format');
    }
    return key;
};

exports.language = function (language){
    let acceptedLanguages = ['en-US', 'pt-BR'];
    if(acceptedLanguages.includes(language)){
        return language;
    }
    throw Error(`Language must be one from ${acceptedLanguages}`)
}

exports.dateTimeOrDate = function (input) {
    if (!input) {
        return null;
    }
    if (typeof input === 'string') {
        return input;
    }
    let date = new Date(input);
    let time = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
    if (time == '0:0:0') {
        return formatDate(date);
    }
    return formatDatetime(new Date(input))
};

exports.date = function (input) {
    if (!input) {
        return null;
    }
    if (typeof input === 'string') {
        return input;
    }
    return formatDate(new Date(input));
};

exports.datetime = function (input) {
    if (!input) {
        return null;
    }
    if (typeof input === 'string') {
        return input;
    }
    return formatDatetime(new Date(input));
};

exports.queryBool = function (bool) {
    return typeof bool === 'undefined' ? null : bool.toString();
}
