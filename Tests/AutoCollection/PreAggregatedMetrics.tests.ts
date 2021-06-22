import assert = require("assert");
import sinon = require("sinon");

import AppInsights = require("../../applicationinsights");
import AutoCollectPreAggregatedMetrics = require("../../AutoCollection/PreAggregatedMetrics");
import TelemetryClient = require("../../Library/TelemetryClient");

describe("AutoCollection/PreAggregatedMetrics", () => {
    afterEach(() => {
        AppInsights.dispose();
    });
    describe("#init and #dispose()", () => {
        it("init should enable and dispose should stop autocollection interval", () => {
            var setIntervalSpy = sinon.spy(global, "setInterval");
            var clearIntervalSpy = sinon.spy(global, "clearInterval");
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
                .setAutoCollectHeartbeat(false)
                .setAutoCollectPerformance(false, false)
                .setAutoCollectPreAggregatedMetrics(true)
                .start();
            assert.equal(setIntervalSpy.callCount, 1, "setInteval should be called once as part of PreAggregatedMetrics initialization");
            AppInsights.dispose();
            assert.equal(clearIntervalSpy.callCount, 1, "clearInterval should be called once as part of PreAggregatedMetrics shutdown");

            setIntervalSpy.restore();
            clearIntervalSpy.restore();
        });
    });

    describe("#trackRequestMetrics()", () => {
        it("should not produce incorrect metrics because of multiple instances of AutoCollectPreAggregatedMetrics class", (done) => {
            const setIntervalStub = sinon.stub(global, "setInterval", () => ({ unref: () => { } }));
            const clearIntervalSpy = sinon.spy(global, "clearInterval");
            const appInsights = AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").setAutoCollectPerformance(false).start();
            const autoCollect1 = new AutoCollectPreAggregatedMetrics(new TelemetryClient("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333"), 1234);
            const autoCollect2 = new AutoCollectPreAggregatedMetrics(new TelemetryClient("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333"), 4321);
            autoCollect1.enable(true);
            autoCollect2.enable(true);
            AutoCollectPreAggregatedMetrics.INSTANCE.enable(true);
            const stub1 = sinon.stub(autoCollect1["_client"], "trackMetric");
            const stub2 = sinon.stub(autoCollect2["_client"], "trackMetric");

            AutoCollectPreAggregatedMetrics.countRequest(1000, {});
            AutoCollectPreAggregatedMetrics.countRequest(2000, {});
            setTimeout(() => {
                autoCollect1["_trackRequestMetrics"]();
                autoCollect2["_trackRequestMetrics"]();
                AutoCollectPreAggregatedMetrics.countRequest(5000, {});

                assert.deepEqual(AutoCollectPreAggregatedMetrics["_requestCountersCollection"][0]["lastIntervalExecutionTime"], 1000 + 2000);

                // Add to end of event loop
                setTimeout(() => {
                    // need to wait at least 1 ms so _trackRequestMetrics has valid elapsedMs value
                    const counter = AutoCollectPreAggregatedMetrics["_getAggregatedCounter"]({}, AutoCollectPreAggregatedMetrics["_requestCountersCollection"]);
                    assert.equal(counter.intervalExecutionTime, 1000 + 2000 + 5000);
                    assert.equal(stub1.callCount, 1, "calls trackMetric");
                    assert.equal(stub2.callCount, 0, "No calls to trackMetric");
                    assert.equal(stub1.args[0][0].value, (1000 + 2000) / 2, "request duration average should be 1500");

                    stub1.reset();

                    appInsights.setAutoCollectPerformance(true); // set back to default of true so tests expecting the default can pass
                    AutoCollectPreAggregatedMetrics.INSTANCE.dispose();
                    autoCollect1.dispose();
                    autoCollect2.dispose();
                    stub1.restore();
                    setIntervalStub.restore();
                    clearIntervalSpy.restore();
                    done();
                }, 100);
            }, 100);
        });
    });


});
