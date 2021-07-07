import { SpanContext } from "@opentelemetry/api";
import { Span } from "@opentelemetry/tracing";

import { CorrelationContextManager, CorrelationContext } from "./CorrelationContextManager"
import { EventEmitter } from "events";

export class OpenTelemetryScopeManagerWrapper {
    private _activeSymbol: symbol | undefined;

    public active() {
        const context = CorrelationContextManager.getCurrentContext() as any;
        return {
            ...context,
            getValue: (key: symbol) => {
                // todo: lazy import activeSymbol from opentelemetry/api
                if (!this._activeSymbol) {
                    this._activeSymbol = key;
                    return context;
                }

                if (key === this._activeSymbol) {
                    return context;
                }

                return false;
            },
            setValue: () => { }
        };
    }

    public with(span: Span, fn: () => any) {
        const parentSpanId = span.parentSpanId;
        const name = span.name;
        const correlationContext = OpenTelemetryScopeManagerWrapper._spanToContext(span, parentSpanId, name);
        return CorrelationContextManager.runWithContext(correlationContext, fn)();
    }

    public bind<T>(target: T): T {
        if (typeof target === "function") {
            return CorrelationContextManager.wrapCallback(target);
        } else if (target instanceof EventEmitter) {
            CorrelationContextManager.wrapEmitter(target);
        }
        return target;
    }

    public enable(): this {
        CorrelationContextManager.enable();
        return this;
    }

    public disable(): this {
        CorrelationContextManager.disable();
        return this;
    }

    private static _spanToContext(span: Span, parentSpanId?: string, name?: string): CorrelationContext {
        const _parentId = parentSpanId ? `|${span.spanContext().traceId}.${parentSpanId}.` : span.spanContext().traceId;
        const context: SpanContext = {
            ...span.spanContext(),
            traceFlags: span.spanContext().traceFlags
        };
        const correlationContext = CorrelationContextManager.spanToContextObject(context, _parentId, name)
        return correlationContext;
    }
}

export const AsyncScopeManager = new OpenTelemetryScopeManagerWrapper();
