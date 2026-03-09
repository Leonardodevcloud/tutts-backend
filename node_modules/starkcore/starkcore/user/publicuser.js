const checkEnvironment = require('../utils/check');

class PublicUser {
        constructor({
                    environment
                }) {
        this.environment = checkEnvironment(environment);
    }
}