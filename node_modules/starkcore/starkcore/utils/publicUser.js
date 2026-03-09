const check = require('./check');

class PublicUser {
    constructor({ environment }) {
        this.environment = check.environment(environment);
    }
}

exports.PublicUser = PublicUser;
