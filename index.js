'use strict';

const Executor = class {
    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config   A configuration object
     * @param  {Function} callback Callback function
     */
    start(config, callback) {
        process.nextTick(callback);
    }
};

module.exports = Executor;
