import * as path from "path";
import http = require("http");
import fs = require('fs');

import Logging = require("../Library/Logging");
import TelemetryClient = require("../Library/TelemetryClient");

class WebSnippet {

    public static INSTANCE: WebSnippet;

    private static _snippet: string;
    private static _aiUrl: string;
    private _isEnabled: boolean;
    private _isInitialized: boolean;

    constructor(client: TelemetryClient) {
        if (!!WebSnippet.INSTANCE) {
            throw new Error("Web snippet injection should be configured from the applicationInsights object");
        }

        WebSnippet.INSTANCE = this;
        // AI URL used to validate if snippet already included
        WebSnippet._aiUrl = "https://az416426.vo.msecnd.net/scripts/b/ai.2";

        let snippetPath = path.resolve(__dirname, "../../AutoCollection/WebSnippet/snippet.min.js");
        if (client.config.isDebugWebSnippet) {
            snippetPath = path.resolve(__dirname, "../../AutoCollection/WebSnippet/snippet.js");
        }
        fs.readFile(snippetPath, function (err, snippet) {
            if (err) {
                Logging.warn("Failed to load AI Web snippet. Ex:" + err);
            }
            WebSnippet._snippet = snippet.toString().replace("INSTRUMENTATION_KEY", client.config.instrumentationKey);
        });
    }

    public enable(isEnabled: boolean) {
        this._isEnabled = isEnabled;

        if (this._isEnabled && !this._isInitialized) {
            this._initialize();
        }
    }

    public isInitialized() {
        return this._isInitialized;
    }

    private _initialize() {
        this._isInitialized = true;
        const originalHttpServer = http.createServer;
        http.createServer = (requestListener?: (request: http.IncomingMessage, response: http.ServerResponse) => void) => {
            const originalRequestListener = requestListener;
            if (originalRequestListener) {
                requestListener = (request: http.IncomingMessage, response: http.ServerResponse) => {
                    // Patch response write method
                    let originalResponseWrite = response.write;
                    let isEnabled = this._isEnabled;
                    response.write = function wrap(a: Buffer | string, b?: Function | string, c?: Function | string) {
                        if (isEnabled) {
                            if (WebSnippet.ValidateInjection(response, a)) {
                                arguments[0] = WebSnippet.InjectWebSnippet(response, a);
                            }
                        }
                        return originalResponseWrite.apply(response, arguments);
                    }
                    // Patch response end method for cases when HTML is added there
                    let originalResponseEnd = response.end;

                    response.end = function wrap(a?: Buffer | string | any, b?: Function | string, c?: Function) {
                        if (isEnabled) {
                            if (WebSnippet.ValidateInjection(response, a)) {
                                arguments[0] = WebSnippet.InjectWebSnippet(response, a);
                            }
                        }
                        originalResponseEnd.apply(response, arguments);
                    }

                    originalRequestListener(request, response);
                }
            }
            return originalHttpServer(requestListener);
        }
    }

    /**
     * Validate response and try to inject Web snippet
     */
    public static ValidateInjection(response: http.ServerResponse, input: string | Buffer): boolean {
        if (response && input) {
            let contentType = response.getHeader('Content-Type');
            let contentEncoding = response.getHeader('Content-Encoding'); // Compressed content not supported for injection
            if (!contentEncoding && contentType && contentType.toLowerCase().indexOf("text/html") >= 0) {
                let html = input.toString();
                if (html.indexOf("<head>") >= 0 && html.indexOf("</head>") >= 0) {
                    // Check if snippet not already present looking for AI Web SDK URL
                    if (html.indexOf(WebSnippet._aiUrl) < 0) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Inject Web snippet
     */
    public static InjectWebSnippet(response: http.ServerResponse, input: string | Buffer): string | Buffer {
        try {
            // Clean content-length header
            response.removeHeader('Content-Length');
            // Read response stream
            let html = input.toString();
            // Try to add script before HTML head closure
            let index = html.indexOf("</head>");
            if (index >= 0) {
                let subStart = html.substring(0, index);
                let subEnd = html.substring(index);
                input = subStart + '<script type="text/javascript">' + WebSnippet._snippet + '</script>' + subEnd;
                // Set headers
                response.setHeader("Content-Length", input.length.toString());
            }
        }
        catch (ex) {
            Logging.info("Failed to change content-lenght headers for JS injection. Exception:" + ex);
        }
        return input;
    }

    public dispose() {
        WebSnippet.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
    }
}

export = WebSnippet;
