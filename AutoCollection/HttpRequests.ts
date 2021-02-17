import http = require("http");
import https = require("https");
import url = require("url");

import Contracts = require("../Declarations/Contracts");
import TelemetryClient = require("../Library/TelemetryClient");
import Logging = require("../Library/Logging");
import Util = require("../Library/Util");
import RequestResponseHeaders = require("../Library/RequestResponseHeaders");
import HttpRequestParser = require("./HttpRequestParser");
import { CorrelationContextManager, CorrelationContext, PrivateCustomProperties } from "./CorrelationContextManager";
import AutoCollectPerformance = require("./Performance");

class AutoCollectHttpRequests {

    public static INSTANCE: AutoCollectHttpRequests;

    private static alreadyAutoCollectedFlag = '_appInsightsAutoCollected';

    private _client: TelemetryClient;
    private _isEnabled: boolean;
    private _isInitialized: boolean;
    private _isAutoCorrelating: boolean;

    constructor(client: TelemetryClient) {
        if (!!AutoCollectHttpRequests.INSTANCE) {
            throw new Error("Server request tracking should be configured from the applicationInsights object");
        }

        AutoCollectHttpRequests.INSTANCE = this;
        this._client = client;
    }

    public enable(isEnabled: boolean) {
        this._isEnabled = isEnabled;

        // Autocorrelation requires automatic monitoring of incoming server requests
        // Disabling autocollection but enabling autocorrelation will still enable
        // request monitoring but will not produce request events
        if ((this._isAutoCorrelating || this._isEnabled || AutoCollectPerformance.isEnabled()) && !this._isInitialized) {
            this.useAutoCorrelation(this._isAutoCorrelating);
            this._initialize();
        }
    }

    public useAutoCorrelation(isEnabled: boolean, forceClsHooked?: boolean) {
        if (isEnabled && !this._isAutoCorrelating) {
            CorrelationContextManager.enable(forceClsHooked);
        } else if (!isEnabled && this._isAutoCorrelating) {
            CorrelationContextManager.disable();
        }
        this._isAutoCorrelating = isEnabled;
    }

    public isInitialized() {
        return this._isInitialized;
    }

    public isAutoCorrelating() {
        return this._isAutoCorrelating;
    }

    private _generateCorrelationContext(requestParser: HttpRequestParser): CorrelationContext {
        if (!this._isAutoCorrelating) {
            return;
        }

        return CorrelationContextManager.generateContextObject(
            requestParser.getOperationId(this._client.context.tags),
            requestParser.getRequestId(),
            requestParser.getOperationName(this._client.context.tags),
            requestParser.getCorrelationContextHeader(),
            requestParser.getTraceparent(),
            requestParser.getTracestate()
        );
    }

    private _initialize() {
        this._isInitialized = true;

        const wrapOnRequestHandler: Function = (onRequest?: Function) => {
            if (!onRequest) {
                return undefined;
            }
            if (typeof onRequest !== 'function') {
                throw new Error('onRequest handler must be a function');
            }
            return (request: http.ServerRequest, response: http.ServerResponse) => {
                CorrelationContextManager.wrapEmitter(request);
                CorrelationContextManager.wrapEmitter(response);
                const shouldCollect: boolean = request && !(<any>request)[AutoCollectHttpRequests.alreadyAutoCollectedFlag];

                if (request && shouldCollect) {
                    // Set up correlation context
                    const requestParser = new HttpRequestParser(request);
                    const correlationContext = this._generateCorrelationContext(requestParser);

                    // Note: Check for if correlation is enabled happens within this method.
                    // If not enabled, function will directly call the callback.
                    CorrelationContextManager.runWithContext(correlationContext, () => {
                        if (this._isEnabled) {
                            // Mark as auto collected
                            (<any>request)[AutoCollectHttpRequests.alreadyAutoCollectedFlag] = true;

                            // Auto collect request
                            AutoCollectHttpRequests.trackRequest(this._client, { request: request, response: response }, requestParser);
                        }

                        if (typeof onRequest === "function") {
                            onRequest(request, response);
                        }
                    });
                } else {
                    if (typeof onRequest === "function") {
                        onRequest(request, response);
                    }
                }
            }
        }

        // The `http.createServer` function will instantiate a new http.Server object.
        // Inside the Server's constructor, it is using addListener to register the
        // onRequest handler. So there are two ways to inject the wrapped onRequest handler:
        // 1) Overwrite Server.prototype.addListener (and .on()) globally and not patching
        //    the http.createServer call. Or
        // 2) Overwrite the http.createServer method and add a patched addListener to the
        //    fresh server instance. This seems more stable for possible future changes as
        //    it also covers the case where the Server might not use addListener to manage
        //    the callback internally.
        //    And also as long as the constructor uses addListener to add the handle, it is
        //    ok to patch the addListener after construction only. Because if we would patch
        //    the prototype one and the createServer method, we would wrap the handler twice
        //    in case of the constructor call.
        const wrapServerEventHandler: Function = (server: (http.Server | https.Server)) => {
            const originalAddListener = server.addListener.bind(server);
            server.addListener = (eventType: string, eventHandler: Function) => {
                switch (eventType) {
                    case 'request':
                    case 'checkContinue':
                        return originalAddListener(eventType, wrapOnRequestHandler(eventHandler));
                    default:
                        return originalAddListener(eventType, eventHandler);
                }
            };
            // on is an alias to addListener only
            server.on = server.addListener;
        }

        const originalHttpServer: any = http.createServer;

        // options parameter was added in Node.js v9.6.0, v8.12.0
        // function createServer(requestListener?: RequestListener): Server;
        // function createServer(options: ServerOptions, requestListener?: RequestListener): Server;
        http.createServer = (param1?: Object, param2?: Function) => {
            // todo: get a pointer to the server so the IP address can be read from server.address
            if (param2 && typeof param2 === 'function') {
                const server: http.Server = originalHttpServer(param1, wrapOnRequestHandler(param2));
                wrapServerEventHandler(server);
                return server;
            }
            else {
                const server: http.Server = originalHttpServer(wrapOnRequestHandler(param1));
                wrapServerEventHandler(server);
                return server;
            }
        }

        const originalHttpsServer = https.createServer;
        https.createServer = (options: https.ServerOptions, onRequest?: Function) => {
            const server: https.Server = originalHttpsServer(options, wrapOnRequestHandler(onRequest));
            wrapServerEventHandler(server);
            return server;
        }
    }

    /**
     * Tracks a request synchronously (doesn't wait for response 'finish' event)
     */
    public static trackRequestSync(client: TelemetryClient, telemetry: Contracts.NodeHttpRequestTelemetry) {
        if (!telemetry.request || !telemetry.response || !client) {
            Logging.info("AutoCollectHttpRequests.trackRequestSync was called with invalid parameters: ", !telemetry.request, !telemetry.response, !client);
            return;
        }

        AutoCollectHttpRequests.addResponseCorrelationIdHeader(client, telemetry.response);

        // store data about the request
        var correlationContext = CorrelationContextManager.getCurrentContext();
        var requestParser = new HttpRequestParser(telemetry.request, (correlationContext && correlationContext.operation.parentId));

        // Overwrite correlation context with request parser results
        if (correlationContext) {
            correlationContext.operation.id = requestParser.getOperationId(client.context.tags) || correlationContext.operation.id;
            correlationContext.operation.name = requestParser.getOperationName(client.context.tags) || correlationContext.operation.name;
            correlationContext.operation.parentId = requestParser.getRequestId() || correlationContext.operation.parentId;
            (<PrivateCustomProperties>correlationContext.customProperties).addHeaderData(requestParser.getCorrelationContextHeader());
        }

        AutoCollectHttpRequests.endRequest(client, requestParser, telemetry, telemetry.duration, telemetry.error);
    }

    /**
     * Tracks a request by listening to the response 'finish' event
     */
    public static trackRequest(client: TelemetryClient, telemetry: Contracts.NodeHttpRequestTelemetry, _requestParser?: HttpRequestParser) {
        if (!telemetry.request || !telemetry.response || !client) {
            Logging.warn("AutoCollectHttpRequests.trackRequest was called with invalid parameters: ", !telemetry.request, !telemetry.response, !client);
            return;
        }

        // store data about the request
        var correlationContext = CorrelationContextManager.getCurrentContext();
        var requestParser = _requestParser || new HttpRequestParser(telemetry.request, correlationContext && correlationContext.operation.parentId);

        if (Util.canIncludeCorrelationHeader(client, requestParser.getUrl())) {
            AutoCollectHttpRequests.addResponseCorrelationIdHeader(client, telemetry.response);
        }

        // Overwrite correlation context with request parser results (if not an automatic track. we've already precalculated the correlation context in that case)
        if (correlationContext && !_requestParser) {
            correlationContext.operation.id = requestParser.getOperationId(client.context.tags) || correlationContext.operation.id;
            correlationContext.operation.name = requestParser.getOperationName(client.context.tags) || correlationContext.operation.name;
            correlationContext.operation.parentId = requestParser.getOperationParentId(client.context.tags) || correlationContext.operation.parentId;
            (<PrivateCustomProperties>correlationContext.customProperties).addHeaderData(requestParser.getCorrelationContextHeader());
        }

        // response listeners
        if (telemetry.response.once) {
            telemetry.response.once("finish", () => {
                AutoCollectHttpRequests.endRequest(client, requestParser, telemetry, null, null);
            });
        }

        // track a failed request if an error is emitted
        if (telemetry.request.on) {
            telemetry.request.on("error", (error: any) => {
                AutoCollectHttpRequests.endRequest(client, requestParser, telemetry, null, error);
            });
        }
    }

    /**
     * Add the target correlationId to the response headers, if not already provided.
     */
    private static addResponseCorrelationIdHeader(client: TelemetryClient, response: http.ServerResponse) {
        if (client.config && client.config.correlationId &&
            response.getHeader && response.setHeader && !(<any>response).headersSent) {
            const correlationHeader = <any>response.getHeader(RequestResponseHeaders.requestContextHeader);
            Util.safeIncludeCorrelationHeader(client, response, correlationHeader);
        }
    }

    private static endRequest(client: TelemetryClient, requestParser: HttpRequestParser, telemetry: Contracts.NodeHttpRequestTelemetry, ellapsedMilliseconds?: number, error?: any) {
        if (error) {
            requestParser.onError(error, ellapsedMilliseconds);
        } else {
            requestParser.onResponse(telemetry.response, ellapsedMilliseconds);
        }

        var requestTelemetry = requestParser.getRequestTelemetry(telemetry);

        requestTelemetry.tagOverrides = requestParser.getRequestTags(client.context.tags);
        if (telemetry.tagOverrides) {
            for (let key in telemetry.tagOverrides) {
                requestTelemetry.tagOverrides[key] = telemetry.tagOverrides[key];
            }
        }

        const legacyRootId = requestParser.getLegacyRootId();
        if (legacyRootId) {
            requestTelemetry.properties["ai_legacyRootId"] = legacyRootId;
        }

        requestTelemetry.contextObjects = requestTelemetry.contextObjects || {};
        requestTelemetry.contextObjects["http.ServerRequest"] = telemetry.request;
        requestTelemetry.contextObjects["http.ServerResponse"] = telemetry.response;

        client.trackRequest(requestTelemetry);
    }

    public dispose() {
        AutoCollectHttpRequests.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
        CorrelationContextManager.disable();
        this._isAutoCorrelating = false;
    }
}



export = AutoCollectHttpRequests;
