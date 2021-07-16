import url = require("url");
import os = require("os");
import azureCore = require("@azure/core-http");

import Config = require("./Config");
import Context = require("./Context");
import Contracts = require("../Declarations/Contracts");
import Channel = require("./Channel");
import TelemetryProcessors = require("../TelemetryProcessors");
import { CorrelationContextManager } from "../AutoCollection/CorrelationContextManager";
import { Statsbeat } from "../AutoCollection/Statsbeat";
import Sender = require("./Sender");
import Util = require("./Util");
import Logging = require("./Logging");
import FlushOptions = require("./FlushOptions");
import EnvelopeFactory = require("./EnvelopeFactory");
import QuickPulseStateManager = require("./QuickPulseStateManager");
import { Tags } from "../Declarations/Contracts";

/**
 * Application Insights telemetry client provides interface to track telemetry items, register telemetry initializers and
 * and manually trigger immediate sending (flushing)
 */
class TelemetryClient {
    private _telemetryProcessors: { (envelope: Contracts.EnvelopeTelemetry, contextObjects: { [name: string]: any; }): boolean; }[] = [];
    private _enableAzureProperties: boolean = false;
    private _statsbeat: Statsbeat;

    public config: Config;
    public context: Context;
    public commonProperties: { [key: string]: string; };
    public channel: Channel;
    public quickPulseClient: QuickPulseStateManager;

    /**
     * Constructs a new client of the client
     * @param setupString the Connection String or Instrumentation Key to use (read from environment variable if not specified)
     */
    constructor(setupString?: string) {
        var config = new Config(setupString);
        this.config = config;
        this.context = new Context();
        this.commonProperties = {};
        this._statsbeat = new Statsbeat(this.config);
        this._statsbeat.enable(true);
        var sender = new Sender(this.config, null, null, this._statsbeat);
        this.channel = new Channel(() => config.disableAppInsights, () => config.maxBatchSize, () => config.maxBatchIntervalMs, sender);
    }

    /**
     * Log information about availability of an application
     * @param telemetry      Object encapsulating tracking options
     */
    public trackAvailability(telemetry: Contracts.AvailabilityTelemetry): void {
        this.track(telemetry, Contracts.TelemetryType.Availability);
    }

    /**
     * Log a page view
     * @param telemetry      Object encapsulating tracking options
     */
    public trackPageView(telemetry: Contracts.PageViewTelemetry): void {
        this.track(telemetry, Contracts.TelemetryType.PageView);
    }

    /**
     * Log a trace message
     * @param telemetry      Object encapsulating tracking options
     */
    public trackTrace(telemetry: Contracts.TraceTelemetry): void {
        this.track(telemetry, Contracts.TelemetryType.Trace);
    }

    /**
     * Log a numeric value that is not associated with a specific event. Typically used to send regular reports of performance indicators.
     * To send a single measurement, use just the first two parameters. If you take measurements very frequently, you can reduce the
     * telemetry bandwidth by aggregating multiple measurements and sending the resulting average at intervals.
     * @param telemetry      Object encapsulating tracking options
     */
    public trackMetric(telemetry: Contracts.MetricTelemetry): void {
        this.track(telemetry, Contracts.TelemetryType.Metric);
    }

    /**
     * Log an exception
     * @param telemetry      Object encapsulating tracking options
     */
    public trackException(telemetry: Contracts.ExceptionTelemetry): void {
        if (telemetry && telemetry.exception && !Util.isError(telemetry.exception)) {
            telemetry.exception = new Error(telemetry.exception.toString());
        }
        this.track(telemetry, Contracts.TelemetryType.Exception);
    }

    /**
     * Log a user action or other occurrence.
     * @param telemetry      Object encapsulating tracking options
     */
    public trackEvent(telemetry: Contracts.EventTelemetry): void {
        this.track(telemetry, Contracts.TelemetryType.Event);
    }

    /**
     * Log a request. Note that the default client will attempt to collect HTTP requests automatically so only use this for requests
     * that aren't automatically captured or if you've disabled automatic request collection.
     *
     * @param telemetry      Object encapsulating tracking options
     */
    public trackRequest(telemetry: Contracts.RequestTelemetry & Contracts.Identified): void {
        this.track(telemetry, Contracts.TelemetryType.Request);
    }

    /**
     * Log a dependency. Note that the default client will attempt to collect dependencies automatically so only use this for dependencies
     * that aren't automatically captured or if you've disabled automatic dependency collection.
     *
     * @param telemetry      Object encapsulating tracking option
     * */
    public trackDependency(telemetry: Contracts.DependencyTelemetry & Contracts.Identified) {

        if (telemetry && !telemetry.target && telemetry.data) {
            // url.parse().host returns null for non-urls,
            // making this essentially a no-op in those cases
            // If this logic is moved, update jsdoc in DependencyTelemetry.target
            telemetry.target = url.parse(telemetry.data).host;
        }
        this.track(telemetry, Contracts.TelemetryType.Dependency);
    }

    /**
     * Immediately send all queued telemetry.
     * @param options Flush options, including indicator whether app is crashing and callback
     */
    public flush(options?: FlushOptions) {
        this.channel.triggerSend(
            options ? !!options.isAppCrashing : false,
            options ? options.callback : undefined);
    }

    /**
     * Generic track method for all telemetry types
     * @param data the telemetry to send
     * @param telemetryType specify the type of telemetry you are tracking from the list of Contracts.DataTypes
     */
    public track(telemetry: Contracts.Telemetry, telemetryType: Contracts.TelemetryType) {
        if (telemetry && Contracts.telemetryTypeToBaseType(telemetryType)) {
            var envelope = EnvelopeFactory.createEnvelope(telemetry, telemetryType, this.commonProperties, this.context, this.config);

            // Set time on the envelope if it was set on the telemetry item
            if (telemetry.time) {
                envelope.time = telemetry.time.toISOString();
            }
            if (this._enableAzureProperties) {
                TelemetryProcessors.azureRoleEnvironmentTelemetryProcessor(envelope, this.context);
            }
            var accepted = this.runTelemetryProcessors(envelope, telemetry.contextObjects);

            // Ideally we would have a central place for "internal" telemetry processors and users can configure which ones are in use.
            // This will do for now. Otherwise clearTelemetryProcessors() would be problematic.
            accepted = accepted && TelemetryProcessors.samplingTelemetryProcessor(envelope, { correlationContext: CorrelationContextManager.getCurrentContext() });
            TelemetryProcessors.preAggregatedMetricsTelemetryProcessor(envelope, this.context);
            if (accepted) {
                TelemetryProcessors.performanceMetricsTelemetryProcessor(envelope, this.quickPulseClient);
                this.channel.send(envelope);
            }
        }
        else {
            Logging.warn("track() requires telemetry object and telemetryType to be specified.")
        }
    }

    /**
     * Automatically populate telemetry properties like RoleName when running in Azure
     *
      * @param value if true properties will be populated
     */
    public setAutoPopulateAzureProperties(value: boolean) {
        this._enableAzureProperties = value;
    }

    /**
     * Adds telemetry processor to the collection. Telemetry processors will be called one by one
     * before telemetry item is pushed for sending and in the order they were added.
     *
     * @param telemetryProcessor function, takes Envelope, and optional context object and returns boolean
     */
    public addTelemetryProcessor(telemetryProcessor: (envelope: Contracts.EnvelopeTelemetry, contextObjects?: { [name: string]: any; }) => boolean) {
        this._telemetryProcessors.push(telemetryProcessor);
    }

    /*
     * Removes all telemetry processors
     */
    public clearTelemetryProcessors() {
        this._telemetryProcessors = [];
    }

    private runTelemetryProcessors(envelope: Contracts.EnvelopeTelemetry, contextObjects: { [name: string]: any; }): boolean {
        var accepted = true;
        var telemetryProcessorsCount = this._telemetryProcessors.length;

        if (telemetryProcessorsCount === 0) {
            return accepted;
        }

        contextObjects = contextObjects || {};
        contextObjects['correlationContext'] = CorrelationContextManager.getCurrentContext();

        for (var i = 0; i < telemetryProcessorsCount; ++i) {
            try {
                var processor = this._telemetryProcessors[i];
                if (processor) {
                    if (processor.apply(null, [envelope, contextObjects]) === false) {
                        accepted = false;
                        break;
                    }
                }

            } catch (error) {
                accepted = true;
                Logging.warn("One of telemetry processors failed, telemetry item will be sent.", error, envelope);
            }
        }

        // Sanitize tags and properties after running telemetry processors
        if (accepted) {
            if (envelope && envelope.tags) {
                envelope.tags = Util.validateStringMap(envelope.tags) as Tags & Tags[];
            }
            if (envelope && envelope.data && envelope.data.baseData && envelope.data.baseData.properties) {
                envelope.data.baseData.properties = Util.validateStringMap(envelope.data.baseData.properties);
            }
        }

        return accepted;
    }

    /*
     * Get Statsbeat instance
     */
    public getStatsbeat() {
        return this._statsbeat;
    }
}

export = TelemetryClient;
