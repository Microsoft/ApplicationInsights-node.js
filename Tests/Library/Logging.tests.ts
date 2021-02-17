import assert = require("assert");
import sinon = require("sinon");

import Logging = require("../../Library/Logging");

describe("Library/Logging", () => {

    describe("#debug(message, ...optionalParams: any)", () => {
        it("should do nothing if disabled", () => {
            var originalSetting = Logging.enableDebug;
            Logging.enableDebug = false;
            var debugStub = sinon.stub(Logging.logger, "verbose");
            Logging.debug("test");
            assert.ok(debugStub.notCalled);
            debugStub.restore();
            Logging.enableDebug = originalSetting;
        });

        it("should log 'info' if enabled", () => {
            var originalSetting = Logging.enableDebug;
            Logging.enableDebug = true;
            var infoStub = sinon.stub(Logging.logger, "info");
            Logging.info("test");
            assert.ok(infoStub.calledOnce);
            infoStub.restore();
            Logging.enableDebug = originalSetting;
        });
    });

    describe("#warn(message, ...optionalParams: any)", () => {
        it("should do nothing if disabled", () => {
            var originalSetting = Logging.disableWarnings;
            Logging.disableWarnings= true
            var warnStub = sinon.stub(Logging.logger, "warning");
            Logging.warn("test");
            assert.ok(warnStub.notCalled);
            warnStub.restore();
            Logging.enableDebug = originalSetting;
        });

        it("should log 'warn' if enabled", () => {
            var originalSetting = Logging.disableWarnings;
            Logging.disableWarnings = false;
            var warnStub = sinon.stub(Logging.logger, "warning");
            Logging.warn("test");
            assert.ok(warnStub.calledOnce);
            warnStub.restore();
            Logging.enableDebug = originalSetting;
        });
    });
});
