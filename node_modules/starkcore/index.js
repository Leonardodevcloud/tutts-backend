exports.version = '0.2.0';

exports.cache = {};
exports.user = null;
exports.language = "en-US";

exports.setUser = function (user) {
    exports.user = user;
}

exports.getUser = function () {
    return exports.user;
}

exports.setLanguage = function (language) {
    let acceptedLanguages = ["en-US", "pt-BR"];
    if (!acceptedLanguages.includes(language)) {
        throw new Exception("language must be one of " . join(", ", acceptedLanguages));
    }
    exports.language = language;
}

exports.getLanguage = function () {
    return exports.language
}

// Modules
exports.project = require('./starkcore/user/project.js');
exports.organization = require('./starkcore/user/organization.js');
exports.starkHost = require('./starkcore/utils/host.js');
exports.rest = require('./starkcore/utils/rest.js');
exports.api = require('./starkcore/utils/api.js');
exports.parse = require('./starkcore/utils/parse.js');
exports.check = require('./starkcore/utils/check.js');
exports.subResource = require('./starkcore/utils/subResource.js');
exports.resource = require('./starkcore/utils/resource.js');
exports.publicUser = require('./starkcore/utils/publicUser.js'); 


// Classes
exports.Project = require('./starkcore/user/project.js').Project;
exports.Organization = require('./starkcore/user/organization.js').Organization;
exports.SubResource = require('./starkcore/utils/subResource.js').SubResource;
exports.Resource = require('./starkcore/utils/resource.js').Resource;
exports.PublicUser = require('./starkcore/utils/publicUser.js').PublicUser;