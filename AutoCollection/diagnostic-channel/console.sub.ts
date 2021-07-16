// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import TelemetryClient = require("../../Library/TelemetryClient");
import { SeverityLevel } from "../../Declarations/Contracts";
import { StatsbeatInstrumentation } from "../../Declarations/Constants";

import { channel, IStandardEvent } from "diagnostic-channel";

import { console as consolePub } from "diagnostic-channel-publishers";

let clients: TelemetryClient[] = [];

const subscriber = (event: IStandardEvent<consolePub.IConsoleData>) => {
    let message = event.data.message as Error | string;
    clients.forEach((client) => {
        if (message instanceof Error) {
            client.trackException({ exception: message });
        } else {
            // Message can have a trailing newline
            if (message.lastIndexOf("\n") == message.length - 1) {
                message = message.substring(0, message.length - 1);
            }
            client.trackTrace({ message: message, severity: (event.data.stderr ? SeverityLevel.Warning : SeverityLevel.Information) });
        }
    });
};

export function enable(enabled: boolean, client: TelemetryClient) {
    let statsbeat = client.getStatsbeat();
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<consolePub.IConsoleData>("console", subscriber);
            if (statsbeat) {
                statsbeat.addInstrumentation(StatsbeatInstrumentation.CONSOLE);
            }
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe("console", subscriber);
            if (statsbeat) {
                statsbeat.removeInstrumentation(StatsbeatInstrumentation.CONSOLE);
            }
        }
    }
}

export function dispose() {
    channel.unsubscribe("console", subscriber);
    clients = [];
}
