const api = require('./api');
const error = require('../error.js');
const rest = require('../utils/rest.js');
const stark = require('../../index.js');
const Ellipticcurve = require('starkbank-ecdsa');


exports.parseObjects = function (objects, resource, resourceClass) {
    if (objects == null)
        return null;

    let parsedObjects = [];
    for (let object of objects) {
        if (object instanceof resourceClass) {
            parsedObjects.push(object);
            continue;
        }
        object = Object.assign(new resource['class'](object), object);
        parsedObjects.push(object);
    }
    return parsedObjects;
}

exports.parseAndVerify = async function (resource, content, signature, sdkVersion, apiVersion, host, user, language, timeout) {
    content = await this.verify(content, signature, sdkVersion, apiVersion, host, user, language, timeout)

    let object = Object.assign(new resource['class'](api.lastName(resource['name'])), JSON.parse(content))
    if (resource['name'] === 'Event'){
        object = Object.assign(new resource['class'](), JSON.parse(content)['event']);
    }
    return object;
}

exports.verify = async function (content, signature, sdkVersion, apiVersion, host, user = null, language, timeout) {
    try {
        signature = Ellipticcurve.Signature.fromBase64(signature);
    } catch (e) {
        throw new error.InvalidSignatureError('The provided signature is not valid');
    }
    
    if (await verifySignature(content, signature, sdkVersion, apiVersion, host, user, language, timeout)) {
        return content;
    }
    if (await verifySignature(content, signature, sdkVersion, apiVersion, host, user, language, timeout, true)) {
        return content;
    }
    throw new error.InvalidSignatureError('Provided signature and content do not match Stark public key');
}

async function verifySignature(content, signature, sdkVersion, apiVersion, host, user = null, language, timeout, refresh = false) {
    let publicKey = stark.cache['stark-public-key'];
    if (!publicKey || refresh) {
        let pem = await rest.getPublicKey(sdkVersion, host, apiVersion, user, language, timeout);
        publicKey = Ellipticcurve.PublicKey.fromPem(pem);
        stark.cache['stark-public-key'] = publicKey;

    }
    return Ellipticcurve.Ecdsa.verify(content, signature, publicKey);
}
