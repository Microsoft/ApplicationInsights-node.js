import assert = require("assert");
import sinon = require("sinon");
import { DistributedTracingModes } from "../applicationinsights";

describe("ApplicationInsights", () => {

    describe("#setup()", () => {
        var AppInsights = require("../applicationinsights");
        var Console = require("../AutoCollection/Console");
        var Exceptions = require("../AutoCollection/Exceptions");
        var Performance = require("../AutoCollection/Performance");
        var HttpRequests = require("../AutoCollection/HttpRequests");
        var HttpDependencies = require("../AutoCollection/HttpDependencies");
        var WebSnippet = require("../AutoCollection/WebSnippet");
        beforeEach(() => {
            Console.INSTANCE = undefined;
            Exceptions.INSTANCE = undefined;
            Performance.INSTANCE = undefined;
            HttpRequests.INSTANCE = undefined;
            HttpDependencies.INSTANCE = undefined;
            WebSnippet.INSTANCE= undefined;
        });

        it("should not warn if setup is called once", () => {
            var warnStub = sinon.stub(console, "warn");
            AppInsights.defaultClient = undefined;
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            assert.ok(warnStub.notCalled, "warning was not raised");
            warnStub.restore();
        });

        it("should warn if setup is called twice", () => {
            var warnStub = sinon.stub(console, "warn");
            AppInsights.defaultClient = undefined;
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            assert.ok(warnStub.calledOn, "warning was raised");
            warnStub.restore();
        });

        it("should not overwrite default client if called more than once", () => {
            var warnStub = sinon.stub(console, "warn");
            AppInsights.defaultClient = undefined;
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            var client = AppInsights.defaultClient;
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333");
            assert.ok(client === AppInsights.defaultClient, "client is not overwritten");
            warnStub.restore();
        });
    });

    describe("#start()", () => {
        var AppInsights = require("../applicationinsights");
        var Console = require("../AutoCollection/Console");
        var Exceptions = require("../AutoCollection/Exceptions");
        var Performance = require("../AutoCollection/Performance");
        var HttpRequests = require("../AutoCollection/HttpRequests");
        var HttpDependencies = require("../AutoCollection/HttpDependencies");
        var WebSnippet = require("../AutoCollection/WebSnippet");

        beforeEach(() => {
            Console.INSTANCE = undefined;
            Exceptions.INSTANCE = undefined;
            Performance.INSTANCE = undefined;
            HttpRequests.INSTANCE = undefined;
            HttpDependencies.INSTANCE = undefined;
            WebSnippet.INSTANCE= undefined;
        });

        afterEach(() => AppInsights.defaultClient = undefined);

        it("should warn if start is called before setup", () => {
            var warnStub = sinon.stub(console, "warn");
            AppInsights.start();
            assert.ok(warnStub.calledOn, "warning was raised");
            warnStub.restore();
        });

        it("should not warn if start is called after setup", () => {
            var warnStub = sinon.stub(console, "warn");
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").start();
            assert.ok(warnStub.notCalled, "warning was not raised");
            warnStub.restore();
        });

        it("should not start live metrics", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").start();
            assert.equal(AppInsights.liveMetricsClient, undefined, "live metrics client is not defined");
        });

        it("should not start live metrics", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").setSendLiveMetrics(false).start();
            assert.equal(AppInsights.liveMetricsClient, undefined, "live metrics client is not defined");
        });
    });

    describe("#setDistributedTracingMode", () => {
        var AppInsights = require("../applicationinsights");
        var CorrelationIdManager = require("../Library/CorrelationIdManager");

        beforeEach(() => {
            AppInsights.dispose();
        });
        afterEach(() => {
            AppInsights.dispose();
        })

        it("should enable W3C tracing mode by default", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").start();
            assert.equal(CorrelationIdManager.w3cEnabled, true);
        });

        it("should be able to enable W3C tracing mode via enum", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").setDistributedTracingMode(DistributedTracingModes.AI_AND_W3C).start();
            assert.ok(CorrelationIdManager.w3cEnabled);
        });

        it("should be able to enable W3C tracing mode via number", () => {
            assert.equal(DistributedTracingModes.AI_AND_W3C, 1);
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").setDistributedTracingMode(1).start();
            assert.ok(CorrelationIdManager.w3cEnabled);
        });
    });

    describe("#setAutoCollect", () => {
        var AppInsights = require("../applicationinsights");
        var Console = require("../AutoCollection/Console");
        var Exceptions = require("../AutoCollection/Exceptions");
        var Performance = require("../AutoCollection/Performance");
        var HttpRequests = require("../AutoCollection/HttpRequests");
        var HttpDependencies = require("../AutoCollection/HttpDependencies");
        var WebSnippet = require("../AutoCollection/WebSnippet");

        beforeEach(() => {
            AppInsights.defaultClient = undefined;
            Console.INSTANCE = undefined;
            Exceptions.INSTANCE = undefined;
            Performance.INSTANCE = undefined;
            HttpRequests.INSTANCE = undefined;
            HttpDependencies.INSTANCE = undefined;
            WebSnippet.INSTANCE = undefined;
        });

        it("auto-collection is initialized by default", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333").start();

            //assert.ok(Console.INSTANCE.isInitialized());
            assert.ok(Exceptions.INSTANCE.isInitialized());
            assert.ok(Performance.INSTANCE.isInitialized());
            assert.ok(HttpRequests.INSTANCE.isInitialized());
            assert.ok(HttpRequests.INSTANCE.isAutoCorrelating());
            assert.ok(HttpDependencies.INSTANCE.isInitialized());
        });

        it("auto-collection is not initialized if disabled before 'start'", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
                .setAutoCollectConsole(false)
                .setAutoCollectExceptions(false)
                .setAutoCollectPerformance(false)
                .setAutoCollectRequests(false)
                .setAutoCollectDependencies(false)
                .setAutoDependencyCorrelation(false)
                .setWebSnippetInjection(false)
                .start();

            assert.ok(!Console.INSTANCE.isInitialized());
            assert.ok(!Exceptions.INSTANCE.isInitialized());
            assert.ok(!Performance.INSTANCE.isInitialized());
            assert.ok(!HttpRequests.INSTANCE.isInitialized());
            assert.ok(!HttpRequests.INSTANCE.isAutoCorrelating());
            assert.ok(!HttpDependencies.INSTANCE.isInitialized());
            assert.ok(!WebSnippet.INSTANCE.isInitialized());
        });
    });

    describe("#Provide access to contracts", () => {
        var AppInsights = require("../applicationinsights");
        var Contracts = require("../Declarations/Contracts");

        it("should provide access to severity levels", () => {
            assert.equal(AppInsights.Contracts.SeverityLevel.Information, Contracts.SeverityLevel.Information);
        });
    });

    describe("#getCorrelationContext", () => {
        var AppInsights = require("../applicationinsights");
        var Contracts = require("../Declarations/Contracts");
        var CCM = require("../AutoCollection/CorrelationContextManager").CorrelationContextManager;
        var origGCC = CCM.getCurrentContext;

        beforeEach(() => {
            CCM.getCurrentContext = () => 'context';
        });

        afterEach(() => {
            CCM.getCurrentContext = origGCC;
            CCM.hasEverEnabled = false;
            CCM.cls = undefined;
            CCM.disable();
            AppInsights.dispose();
        });

        it("should provide a context if correlating", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
            .setAutoDependencyCorrelation(true)
            .start();
            assert.equal(AppInsights.getCorrelationContext(), 'context');
        });

        it("should provide a cls-hooked context if force flag set to true", () => {
            if (CCM.canUseClsHooked()) {
                AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
                .setAutoDependencyCorrelation(true, true)
                .start();
                assert.equal(AppInsights.getCorrelationContext(), 'context');
                if (CCM.isNodeVersionCompatible()) {
                    assert.equal(CCM.cls, require('cls-hooked'));
                }
            }
        });

        it("should provide a continuation-local-storage context if force flag set to false", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
            .setAutoDependencyCorrelation(true, false)
            .start();
            assert.equal(AppInsights.getCorrelationContext(), 'context');
            if (CCM.isNodeVersionCompatible()) {
                assert.equal(CCM.cls, require('continuation-local-storage'));
            }
        });

        it("should not provide a context if not correlating", () => {
            AppInsights.setup("1aa11111-bbbb-1ccc-8ddd-eeeeffff3333")
            .setAutoDependencyCorrelation(false)
            .start();
            assert.equal(AppInsights.getCorrelationContext(), null);
        });
    });
});
