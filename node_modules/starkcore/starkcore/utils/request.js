const Url = require('./url.js');
const Check = require('./check.js');
const error = require('../error.js');
const StarkHost = require('./host.js');
const axios = require('axios').default;
const stark = require('../../index'); 
const Ecdsa = require('starkbank-ecdsa').Ecdsa;


class Response {

    constructor(status, content, headers) {
        this.status = status;
        this.content = content;
        this.headers = headers
    }

    json() {
        return this.content;
    }
}

function preProcess(host, sdkVersion, user, method, path, payload, query, version, language, prefix) {
    user = user || stark.user;
    language  = Check.language(language);
    if(!user) {
        throw Error('A user is required to access our API. Check our docs :https://starkbank.com/docs/api#authentication');
    }

    let service = {
        [StarkHost.infra]: "starkinfra",
        [StarkHost.bank]: "starkbank",
        [StarkHost.sign]: "starksign"
    }[host]
    
    let hostname = {
        'production': 'https://api.'+ service +'.com/'+ version,
        'sandbox': 'https://sandbox.api.'+ service +'.com/'+ version,
    }[user.environment]

    let options = {
        'method': method,
    };

    let url = hostname + "/" + path + Url.encode(query);
    let accessTime = Math.round((new Date()).getTime() / 1000);
    let body;

    if(payload && (method === 'POST'|| method === 'PUT' || method === 'PATCH')){
        body = JSON.stringify(payload);
        options['data'] = body;
    }
    
    prefix = prefix? prefix + "-" : ""
    
    options['headers'] = {
        'Access-Time': accessTime,
        'User-Agent': prefix + 'Node-' + process.versions['node'] + '-SDK-' + service + '-' + sdkVersion,
        'Content-Type': 'application/json',
        'Accept-Language': language
    };
    Object.assign(options['headers'], authenticationHeaders(user, body, accessTime, payload, method));
    
    options['url'] = url

    return options
}

exports.fetch = async function(host, sdkVersion, user, method, path, payload = null, query = null, apiVersion = 'v2', language = 'en-US', timeout = 15, prefix = "", throwError = true) {
    let options = preProcess(host, sdkVersion, user, method, path, payload, query, apiVersion, language, prefix);
    let response;
    let content;
    let status;
    try {
        response = await axios(options);
        content = response.data;
        status = response.status;
    } catch (e){
        if (!e.response){
            throw e;
        }
        response = await e.response;
        content = response.data;
        status = response.status;
        if(throwError != false){
            switch (status) {
                case 500:
                    throw new error.InternalServerError(content, status);
                case 400:
                    throw new error.InputErrors(content, status);
                default:
                    throw e;
            }
        }
    }
    return new Response(status, content);
};

function authenticationHeaders(user, body, accessTime, payload, method) {
    if(!user.id) 
        return {}

    let message = user.accessId() + ':' + accessTime + ':';
    message += payload && (method === 'POST'|| method === 'PUT' || method === 'PATCH') ? body : "";
    
    return {
        'Access-Id': user.accessId(),
        'Access-Time': accessTime,
        'Access-signature': Ecdsa.sign(message, user.privateKey()).toBase64(),
    }
};

exports.fetchBuffer = async function (host, sdkVersion, user, method, path, payload = null, query = null, version = 'v2', language = 'en-US', timeout = 15) {
    let options = preProcess(host, sdkVersion, user, method, path, payload, query, version, language);
    options['responseType'] = 'arraybuffer';
    options['responseEnconding'] = 'binary';
    let content;
    let status;
    try {
        response = await axios(options);
        content = await Buffer.from(response.data, 'binary');
        status = response.status;
    } catch(e) {
        if(!e.response){
            throw e;
        }
        response = await e.response;
        content = response.data;
        status = response.status;
        switch (status) {
            case 400:
            case 404:
                throw new error.InputErrors(JSON.parse(content.toString()), status);
            case 500:
                throw new error.InternalServerError(content.toString(), status);
            default:
                throw e;
        }
    }
    return new Response(status, content);
};