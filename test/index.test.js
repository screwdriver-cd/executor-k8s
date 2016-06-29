'use strict';

describe('start', () => {
    let Executor;

    beforeEach(() => {
        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */
    });

    it('calls back', (done) => {
        const executor = new Executor();

        executor.start({}, done);
    });
});
