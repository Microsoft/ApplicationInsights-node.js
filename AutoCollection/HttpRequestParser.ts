import http = require("http");
import url = require("url");
import net = require("net");

import Contracts = require("../Declarations/Contracts");
import Util = require("../Library/Util");
import RequestResponseHeaders = require("../Library/RequestResponseHeaders");
import RequestParser = require("./RequestParser");
import CorrelationIdManager = require("../Library/CorrelationIdManager");
import Tracestate = require("../Library/Tracestate");
import Traceparent = require("../Library/Traceparent");
import { HttpRequest } from "../Library/Functions";

/**
 * Helper class to read data from the request/response objects and convert them into the telemetry contract
 */
class HttpRequestParser extends RequestParser {
    private static keys = new Contracts.ContextTagKeys();

    private rawHeaders: { [key: string]: string };
    private socketRemoteAddress: string;
    private connectionRemoteAddress: string;
    private legacySocketRemoteAddress: string;
    private userAgent: string;
    private sourceCorrelationId: string;
    private parentId: string;
    private operationId: string;
    private requestId: string;
    private traceparent: Traceparent;
    private tracestate: Tracestate;
    private legacyRootId: string; // if original operationId is not w3c compat, move it here

    private correlationContextHeader: string;

    constructor(request: http.IncomingMessage | HttpRequest, requestId?: string) {
        super();
        if (request) {
            this.method = request.method;
            this.url = this._getAbsoluteUrl(request);
            this.startTime = +new Date();
            this.socketRemoteAddress = (<any>request).socket && (<any>request).socket.remoteAddress;
            this.parseHeaders(request, requestId);
            if ((<any>request).connection) {
                this.connectionRemoteAddress = ((<any>request).connection as net.Socket).remoteAddress;
                this.legacySocketRemoteAddress = (<any>(<any>request).connection)["socket"] && (<any>(<any>request).connection)["socket"].remoteAddress;
            }
        }
    }

    public onError(error: Error | string, ellapsedMilliseconds?: number) {
        this._setStatus(undefined, error);

        // This parameter is only for overrides. setStatus handles this internally for the autocollected case
        if (ellapsedMilliseconds) {
            this.duration = ellapsedMilliseconds;
        }
    }

    public onResponse(response: http.ServerResponse, ellapsedMilliseconds?: number) {
        this._setStatus(response.statusCode, undefined);

        // This parameter is only for overrides. setStatus handles this internally for the autocollected case
        if (ellapsedMilliseconds) {
            this.duration = ellapsedMilliseconds;
        }
    }

    public getRequestTelemetry(baseTelemetry?: Contracts.Telemetry): Contracts.RequestTelemetry {
        var requestTelemetry: Contracts.RequestTelemetry & Contracts.Identified = {
            id: this.requestId,
            name: this.method + " " + new url.URL(this.url).pathname,
            url: this.url,
            /*
            See https://github.com/microsoft/ApplicationInsights-dotnet-server/blob/25d695e6a906fbe977f67be3966d25dbf1c50a79/Src/Web/Web.Shared.Net/RequestTrackingTelemetryModule.cs#L250
            for reference
            */
            source: this.sourceCorrelationId,
            duration: this.duration,
            resultCode: this.statusCode ? this.statusCode.toString() : null,
            success: this._isSuccess(),
            properties: this.properties
        };

        if (baseTelemetry && baseTelemetry.time) {
            requestTelemetry.time = baseTelemetry.time;
        } else if (this.startTime) {
            requestTelemetry.time = new Date(this.startTime);
        }

        // We should keep any parameters the user passed in
        // Except the fields defined above in requestTelemetry, which take priority
        // Except the properties field, where they're merged instead, with baseTelemetry taking priority
        if (baseTelemetry) {
            // Copy missing fields
            for (let key in baseTelemetry) {
                if (!(<any>requestTelemetry)[key]) {
                    (<any>requestTelemetry)[key] = (<any>baseTelemetry)[key];
                }
            }
            // Merge properties
            if (baseTelemetry.properties) {
                for (let key in baseTelemetry.properties) {
                    requestTelemetry.properties[key] = baseTelemetry.properties[key];
                }
            }
        }

        return requestTelemetry;
    }

    public getRequestTags(tags: { [key: string]: string }): { [key: string]: string } {
        // create a copy of the context for requests since client info will be used here
        var newTags = <{ [key: string]: string }>{};
        for (var key in tags) {
            newTags[key] = tags[key];
        }

        // don't override tags if they are already set
        newTags[HttpRequestParser.keys.locationIp] = tags[HttpRequestParser.keys.locationIp] || this._getIp();
        newTags[HttpRequestParser.keys.sessionId] = tags[HttpRequestParser.keys.sessionId] || this._getId("ai_session");
        newTags[HttpRequestParser.keys.userId] = tags[HttpRequestParser.keys.userId] || this._getId("ai_user");
        newTags[HttpRequestParser.keys.userAuthUserId] = tags[HttpRequestParser.keys.userAuthUserId] || this._getId("ai_authUser");
        newTags[HttpRequestParser.keys.operationName] = this.getOperationName(tags);
        newTags[HttpRequestParser.keys.operationParentId] = this.getOperationParentId(tags);
        newTags[HttpRequestParser.keys.operationId] = this.getOperationId(tags);

        return newTags;
    }

    public getOperationId(tags: { [key: string]: string }) {
        return tags[HttpRequestParser.keys.operationId] || this.operationId;
    }

    public getOperationParentId(tags: { [key: string]: string }) {
        return tags[HttpRequestParser.keys.operationParentId] || this.parentId || this.getOperationId(tags);
    }

    public getOperationName(tags: { [key: string]: string }) {
        return tags[HttpRequestParser.keys.operationName] || this.method + " " + new url.URL(this.url).pathname;
    }

    public getRequestId() {
        return this.requestId;
    }

    public getCorrelationContextHeader() {
        return this.correlationContextHeader;
    }

    public getTraceparent() {
        return this.traceparent;
    }

    public getTracestate() {
        return this.tracestate;
    }

    public getLegacyRootId() {
        return this.legacyRootId;
    }

    private _getAbsoluteUrl(request: http.IncomingMessage | HttpRequest): string {
        if (!request.headers) {
            return request.url;
        }

        var encrypted = (<any>request).connection ? ((<any>request).connection as any).encrypted : null;

        var protocol = (encrypted || request.headers["x-forwarded-proto"] == "https") ? "https" : "http";

        var baseUrl = protocol + '://' + request.headers.host + '/';
        var requestUrl = new url.URL(request.url, baseUrl);

        var pathName = requestUrl.pathname;
        var search = requestUrl.search;

        var absoluteUrl = url.format({
            protocol: protocol,
            host: request.headers.host,
            pathname: pathName,
            search: search
        });
        return absoluteUrl;
    }

    private _getIp() {

        // regex to match ipv4 without port
        // Note: including the port would cause the payload to be rejected by the data collector
        var ipMatch = /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/;

        var check = (str: string): string => {
            var results = ipMatch.exec(str);
            if (results) {
                return results[0];
            }
        };

        var ip = check(this.rawHeaders["x-forwarded-for"])
            || check(this.rawHeaders["x-client-ip"])
            || check(this.rawHeaders["x-real-ip"])
            || check(this.connectionRemoteAddress)
            || check(this.socketRemoteAddress)
            || check(this.legacySocketRemoteAddress);

        // node v12 returns this if the address is "localhost"
        if (!ip
            && this.connectionRemoteAddress
            && this.connectionRemoteAddress.substr
            && this.connectionRemoteAddress.substr(0, 2) === "::") {
            ip = "127.0.0.1";
        }

        return ip;
    }

    private _getId(name: string) {
        var cookie = (this.rawHeaders && this.rawHeaders["cookie"] &&
            typeof this.rawHeaders["cookie"] === 'string' && this.rawHeaders["cookie"]) || "";
        var value = HttpRequestParser.parseId(Util.getCookie(name, cookie));
        return value;
    }

    /**
     * Sets this operation's operationId, parentId, requestId (and legacyRootId, if necessary) based on this operation's traceparent
     */
    private setBackCompatFromThisTraceContext() {
        // Set operationId
        this.operationId = this.traceparent.traceId;
        if (this.traceparent.legacyRootId) {
            this.legacyRootId = this.traceparent.legacyRootId;
        }

        // Set parentId with existing spanId
        this.parentId = this.traceparent.parentId;

        // Update the spanId and set the current requestId
        this.traceparent.updateSpanId();
        this.requestId = this.traceparent.getBackCompatRequestId();
    }

    private parseHeaders(request: http.IncomingMessage | HttpRequest, requestId?: string) {

        this.rawHeaders = request.headers || (<any>request).rawHeaders;
        this.userAgent = request.headers && request.headers["user-agent"];
        this.sourceCorrelationId = Util.getCorrelationContextTarget(request, RequestResponseHeaders.requestContextSourceKey);

        if (request.headers) {
            const tracestateHeader = request.headers[RequestResponseHeaders.traceStateHeader] ? request.headers[RequestResponseHeaders.traceStateHeader].toString() : null; // w3c header
            const traceparentHeader = request.headers[RequestResponseHeaders.traceparentHeader] ? request.headers[RequestResponseHeaders.traceparentHeader].toString() : null; // w3c header
            const requestIdHeader = request.headers[RequestResponseHeaders.requestIdHeader] ? request.headers[RequestResponseHeaders.requestIdHeader].toString() : null; // default AI header
            const legacy_parentId = request.headers[RequestResponseHeaders.parentIdHeader] ? request.headers[RequestResponseHeaders.parentIdHeader].toString() : null; // legacy AI header
            const legacy_rootId = request.headers[RequestResponseHeaders.rootIdHeader] ? request.headers[RequestResponseHeaders.rootIdHeader].toString() : null; // legacy AI header

            this.correlationContextHeader = request.headers[RequestResponseHeaders.correlationContextHeader] ? request.headers[RequestResponseHeaders.correlationContextHeader].toString() : null;

            if (CorrelationIdManager.w3cEnabled && (traceparentHeader || tracestateHeader)) {
                // Parse W3C Trace Context headers
                this.traceparent = new Traceparent(traceparentHeader ? traceparentHeader.toString() : null); // new traceparent is always created from this
                this.tracestate = traceparentHeader && tracestateHeader && new Tracestate(tracestateHeader ? tracestateHeader.toString() : null); // discard tracestate if no traceparent is present
                this.setBackCompatFromThisTraceContext();
            } else if (requestIdHeader) {
                // Parse AI headers
                if (CorrelationIdManager.w3cEnabled) {
                    this.traceparent = new Traceparent(null, requestIdHeader);
                    this.setBackCompatFromThisTraceContext();
                } else {
                    this.parentId = requestIdHeader;
                    this.requestId = CorrelationIdManager.generateRequestId(this.parentId);
                    this.operationId = CorrelationIdManager.getRootId(this.requestId);
                }
            } else {
                // Legacy fallback
                if (CorrelationIdManager.w3cEnabled) {
                    this.traceparent = new Traceparent();
                    this.traceparent.parentId = legacy_parentId;
                    this.traceparent.legacyRootId = legacy_rootId || legacy_parentId;
                    this.setBackCompatFromThisTraceContext();
                } else {
                    this.parentId = legacy_parentId;
                    this.requestId = CorrelationIdManager.generateRequestId(legacy_rootId || this.parentId);
                    this.correlationContextHeader = null;
                    this.operationId = CorrelationIdManager.getRootId(this.requestId);
                }
            }

            if (requestId) {
                // For the scenarios that don't guarantee an AI-created context,
                // override the requestId with the provided one.
                this.requestId = requestId;
                this.operationId = CorrelationIdManager.getRootId(this.requestId);
            }
        }
    }

    public static parseId(cookieValue: string): string {
        const cookieParts = cookieValue.split("|");

        if (cookieParts.length > 0) {
            return cookieParts[0];
        }

        return ""; // old behavior was to return "" for incorrect parsing
    }
}

export = HttpRequestParser;
