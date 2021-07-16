import http = require("http");
import https = require("https");
import url = require("url");
import constants = require("constants");

import Logging = require("./Logging");
import Config = require("./Config");
import TelemetryClient = require("../Library/TelemetryClient");
import RequestResponseHeaders = require("./RequestResponseHeaders");
import { HttpRequest } from "../Library/Functions";


class Util {
    public static MAX_PROPERTY_LENGTH = 8192;
    public static tlsRestrictedAgent: https.Agent = new https.Agent(<any>{
        keepAlive: true,
        maxSockets: 25,
        secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 |
            constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1
    });

    /**
     * helper method to access userId and sessionId cookie
     */
    public static getCookie(name: string, cookie: string) {
        var value = "";
        if (name && name.length && typeof cookie === "string") {
            var cookieName = name + "=";
            var cookies = cookie.split(";");
            for (var i = 0; i < cookies.length; i++) {
                var cookie = cookies[i];
                cookie = Util.trim(cookie);
                if (cookie && cookie.indexOf(cookieName) === 0) {
                    value = cookie.substring(cookieName.length, cookies[i].length);
                    break;
                }
            }
        }

        return value;
    }

    /**
     * helper method to trim strings (IE8 does not implement String.prototype.trim)
     */
    public static trim(str: string): string {
        if (typeof str === "string") {
            return str.replace(/^\s+|\s+$/g, "");
        } else {
            return "";
        }
    }

    /**
     * Convert an array of int32 to Base64 (no '==' at the end).
     * MSB first.
     */
    public static int32ArrayToBase64(array: number[]) {
        let toChar = (v: number, i: number) =>
            String.fromCharCode((v >> i) & 0xFF);
        let int32AsString = (v: number) =>
            toChar(v, 24) + toChar(v, 16) + toChar(v, 8) + toChar(v, 0);
        let x = array.map(int32AsString).join("");
        const b = Buffer.from ? Buffer.from(x, "binary") : new Buffer(x, "binary");
        let s = b.toString("base64");
        return s.substr(0, s.indexOf("="));
    }

    /**
     * generate a random 32bit number (-0x80000000..0x7FFFFFFF).
     */
    public static random32() {
        return (0x100000000 * Math.random()) | 0;
    }

    /**
     * generate a random 32bit number (0x00000000..0xFFFFFFFF).
     */
    public static randomu32() {
        return Util.random32() + 0x80000000;
    }

    /**
     * generate W3C-compatible trace id
     * https://github.com/w3c/distributed-tracing/blob/master/trace_context/HTTP_HEADER_FORMAT.md#trace-id
     */
    public static w3cTraceId() {
        var hexValues = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];

        // rfc4122 version 4 UUID without dashes and with lowercase letters
        var oct = "", tmp;
        for (var a = 0; a < 4; a++) {
            tmp = Util.random32();
            oct +=
                hexValues[tmp & 0xF] +
                hexValues[tmp >> 4 & 0xF] +
                hexValues[tmp >> 8 & 0xF] +
                hexValues[tmp >> 12 & 0xF] +
                hexValues[tmp >> 16 & 0xF] +
                hexValues[tmp >> 20 & 0xF] +
                hexValues[tmp >> 24 & 0xF] +
                hexValues[tmp >> 28 & 0xF];
        }

        // "Set the two most significant bits (bits 6 and 7) of the clock_seq_hi_and_reserved to zero and one, respectively"
        var clockSequenceHi = hexValues[8 + (Math.random() * 4) | 0];
        return oct.substr(0, 8) + oct.substr(9, 4) + "4" + oct.substr(13, 3) + clockSequenceHi + oct.substr(16, 3) + oct.substr(19, 12);
    }

    public static w3cSpanId() {
        return Util.w3cTraceId().substring(16);
    }

    public static isValidW3CId(id: string): boolean {
        return id.length === 32 && id !== "00000000000000000000000000000000";
    }

    /**
     * Check if an object is of type Array
     */
    public static isArray(obj: any): boolean {
        return Object.prototype.toString.call(obj) === "[object Array]";
    }

    /**
     * Check if an object is of type Error
     */
    public static isError(obj: any): boolean {
        return obj instanceof Error;
    }

    public static isPrimitive(input: any): boolean {
        const propType = typeof input;
        return propType === "string" || propType === "number" || propType === "boolean";
    }

    /**
     * Check if an object is of type Date
     */
    public static isDate(obj: any): boolean {
        return Object.prototype.toString.call(obj) === "[object Date]";
    }

    /**
     * Convert ms to c# time span format
     */
    public static msToTimeSpan(totalms: number): string {
        if (isNaN(totalms) || totalms < 0) {
            totalms = 0;
        }

        var sec = ((totalms / 1000) % 60).toFixed(7).replace(/0{0,4}$/, "");
        var min = "" + Math.floor(totalms / (1000 * 60)) % 60;
        var hour = "" + Math.floor(totalms / (1000 * 60 * 60)) % 24;
        var days = Math.floor(totalms / (1000 * 60 * 60 * 24));

        sec = sec.indexOf(".") < 2 ? "0" + sec : sec;
        min = min.length < 2 ? "0" + min : min;
        hour = hour.length < 2 ? "0" + hour : hour;
        var daysText = days > 0 ? days + "." : "";

        return daysText + hour + ":" + min + ":" + sec;
    }

    /**
     * Using JSON.stringify, by default Errors do not serialize to something useful:
     * Simplify a generic Node Error into a simpler map for customDimensions
     * Custom errors can still implement toJSON to override this functionality
     */
    protected static extractError(err: Error): { message: string, code: string } {
        // Error is often subclassed so may have code OR id properties:
        // https://nodejs.org/api/errors.html#errors_error_code
        const looseError = err as any;
        return {
            message: err.message,
            code: looseError.code || looseError.id || "",
        }
    }

    /**
     * Manually call toJSON if available to pre-convert the value.
     * If a primitive is returned, then the consumer of this function can skip JSON.stringify.
     * This avoids double escaping of quotes for Date objects, for example.
     */
    protected static extractObject(origProperty: any): any {
        if (origProperty instanceof Error) {
            return Util.extractError(origProperty);
        }
        if (typeof origProperty.toJSON === "function") {
            return origProperty.toJSON();
        }
        return origProperty;
    }

    /**
     * Validate that an object is of type { [key: string]: string }
     */
    public static validateStringMap(obj: any): { [key: string]: string } {
        if (typeof obj !== "object") {
            Logging.info("Invalid properties dropped from payload");
            return;
        }
        const map: { [key: string]: string } = {};
        for (let field in obj) {
            let property: string = '';
            const origProperty: any = obj[field];
            const propType = typeof origProperty;

            if (Util.isPrimitive(origProperty)) {
                property = origProperty.toString();
            } else if (origProperty === null || propType === "undefined") {
                property = "";
            } else if (propType === "function") {
                Logging.info("key: " + field + " was function; will not serialize");
                continue;
            } else {
                const stringTarget = Util.isArray(origProperty) ? origProperty : Util.extractObject(origProperty);
                try {
                    if (Util.isPrimitive(stringTarget)) {
                        property = stringTarget;
                    } else {
                        property = JSON.stringify(stringTarget);
                    }
                } catch (e) {
                    property = origProperty.constructor.name.toString() + " (Error: " + e.message + ")";
                    Logging.info("key: " + field + ", could not be serialized");
                }
            }

            map[field] = property.substring(0, Util.MAX_PROPERTY_LENGTH);
        }
        return map;
    }


    /**
     * Checks if a request url is not on a excluded domain list
     * and if it is safe to add correlation headers
     */
    public static canIncludeCorrelationHeader(client: TelemetryClient, requestUrl: string) {
        let excludedDomains = client && client.config && client.config.correlationHeaderExcludedDomains;
        if (!excludedDomains || excludedDomains.length == 0 || !requestUrl) {
            return true;
        }

        for (let i = 0; i < excludedDomains.length; i++) {
            let regex = new RegExp(excludedDomains[i].replace(/\./g, "\.").replace(/\*/g, ".*"));
            if (regex.test(new url.URL(requestUrl).hostname)) {
                return false;
            }
        }

        return true;
    }

    public static getCorrelationContextTarget(response: http.ClientResponse | http.ServerRequest | HttpRequest, key: string) {
        const contextHeaders = response.headers && response.headers[RequestResponseHeaders.requestContextHeader];
        if (contextHeaders) {
            const keyValues = (<any>contextHeaders).split(",");
            for (let i = 0; i < keyValues.length; ++i) {
                const keyValue = keyValues[i].split("=");
                if (keyValue.length == 2 && keyValue[0] == key) {
                    return keyValue[1];
                }
            }
        }
    }


    /**
     * Generate request
     *
     * Proxify the request creation to handle proxy http
     *
     * @param {string} requestUrl url endpoint
     * @param {Object} requestOptions Request option
     * @param {Function} requestCallback callback on request
     * @returns {http.ClientRequest} request object
     */
    public static makeRequest(
        config: Config,
        requestUrl: string,
        requestOptions: http.RequestOptions | https.RequestOptions,
        requestCallback: (res: http.IncomingMessage) => void): http.ClientRequest {

        if (requestUrl && requestUrl.indexOf('//') === 0) {
            requestUrl = 'https:' + requestUrl;
        }

        var requestUrlParsed = new url.URL(requestUrl);
        var options = {
            ...requestOptions,
            host: requestUrlParsed.hostname,
            port: requestUrlParsed.port,
            path: requestUrlParsed.pathname,
        };

        var proxyUrl: string = undefined;

        if (requestUrlParsed.protocol === 'https:') {
            proxyUrl = config.proxyHttpsUrl || undefined;
        }
        if (requestUrlParsed.protocol === 'http:') {
            proxyUrl = config.proxyHttpUrl || undefined;
        }

        if (proxyUrl) {
            if (proxyUrl.indexOf('//') === 0) {
                proxyUrl = 'http:' + proxyUrl;
            }
            var proxyUrlParsed = new url.URL(proxyUrl);

            // https is not supported at the moment
            if (proxyUrlParsed.protocol === 'https:') {
                Logging.info("Proxies that use HTTPS are not supported");
                proxyUrl = undefined;
            } else {
                options = {
                    ...options,
                    host: proxyUrlParsed.hostname,
                    port: proxyUrlParsed.port || "80",
                    path: requestUrl,
                    headers: {
                        ...options.headers,
                        Host: requestUrlParsed.hostname,
                    },
                };
            }
        }

        var isHttps = requestUrlParsed.protocol === 'https:' && !proxyUrl;

        if (isHttps && config.httpsAgent !== undefined) {
            options.agent = config.httpsAgent;
        } else if (!isHttps && config.httpAgent !== undefined) {
            options.agent = config.httpAgent;
        } else if (isHttps) {
            // HTTPS without a passed in agent. Use one that enforces our TLS rules
            options.agent = Util.tlsRestrictedAgent;
        }

        if (isHttps) {
            return https.request(<any>options, requestCallback);
        } else {
            return http.request(<any>options, requestCallback);
        }

    };

    /**
     * Parse standard <string | string[] | number> request-context header
     */
    public static safeIncludeCorrelationHeader(client: TelemetryClient, request: http.ClientRequest | http.ServerResponse, correlationHeader: any) {
        let header: string; // attempt to cast correlationHeader to string
        if (typeof correlationHeader === "string") {
            header = correlationHeader;
        } else if (correlationHeader instanceof Array) { // string[]
            header = correlationHeader.join(",");
        } else if (correlationHeader && typeof (correlationHeader as any).toString === "function") {
            // best effort attempt: requires well-defined toString
            try {
                header = (correlationHeader as any).toString();
            } catch (err) {
                Logging.warn("Outgoing request-context header could not be read. Correlation of requests may be lost.", err, correlationHeader);
            }
        }

        if (header) {
            Util.addCorrelationIdHeaderFromString(client, request, header);
        } else {
            request.setHeader(
                RequestResponseHeaders.requestContextHeader,
                `${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId}`);
        }
    }

    /**
     * Returns string representation of an object suitable for diagnostics logging.
     */
    public static dumpObj(object: any): string {
        const objectTypeDump: string = Object["prototype"].toString.call(object);
        let propertyValueDump: string = "";
        if (objectTypeDump === "[object Error]") {
            propertyValueDump = "{ stack: '" + object.stack + "', message: '" + object.message + "', name: '" + object.name + "'";
        } else {
            propertyValueDump = JSON.stringify(object);
        }

        return objectTypeDump + propertyValueDump;
    }

    private static addCorrelationIdHeaderFromString(client: TelemetryClient, response: http.ClientRequest | http.ServerResponse, correlationHeader: string) {
        const components = correlationHeader.split(",");
        const key = `${RequestResponseHeaders.requestContextSourceKey}=`;
        const found = components.some(value => value.substring(0, key.length) === key);

        if (!found) {
            response.setHeader(
                RequestResponseHeaders.requestContextHeader,
                `${correlationHeader},${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId}`);
        }
    }
}
export = Util;
