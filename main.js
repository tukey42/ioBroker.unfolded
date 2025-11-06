'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter

/*
 * ioBroker Adapter für Unfolded Circle Remote 3 (WebSocket API)
 * Features:
 *  - WebSocket-Verbindung zur Remote Core API
 *  - Live-Status aller Activities (is_active)
 *  - Möglichkeit, Activities direkt per WebSocket zu starten
 */

const utils = require("@iobroker/adapter-core");
const WebSocket = require("ws");

class Unfolded extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "unfolded",
        });

        this.ws = null;
        this.reconnectTimeout = null;
        this.connected = false;

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    async onReady() {
        const host = this.config.host;
        const port = this.config.port || 80;
        const token = this.config.apikey;

        if (!host || host.trim() === "") {
            this.log.error("Missing host in configuration. Please set it in the adapter settings.");
            return; // Stop initialization
        }

        if (!token || token.trim() === "") {
            this.log.error("Missing API key in configuration. Please set it in the adapter settings.");
            return; // Stop initialization
        }

        const wsUrl = `ws://${host}:${port}/ws`;

        this.log.info(`Verbinde mit Unfolded Circle Remote 3 WebSocket: ${wsUrl}`);

        await this.connectWebSocket(wsUrl, token);
    }

    /**
     * @param {string} url
     * @param {string} token
     */
    async connectWebSocket(url, token) {
        if (this.ws) {
            this.ws.close();
        }

        const headers = token ? { "API-KEY": `${token}` } : {};
        this.ws = new WebSocket(url, { headers });

        this.ws.on("open", () => {
            this.connected = true;
            this.setState("info.connection", true, true);
            this.log.info("WebSocket verbunden mit Remote 3.");

            // Nach Verbindung: Activities abonnieren
            this.subscribeActivities();
            this.requestAllActivities();
        });

        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (err) {
                this.log.warn(`Fehler beim Parsen von WS-Nachricht: ${err.message}`);
            }
        });

        this.ws.on("close", () => {
            this.connected = false;
            this.setState("info.connection", false, true);
            this.log.warn("WebSocket getrennt. Reconnect in 5s ...");
            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(
                () => this.connectWebSocket(url, token),
                5000
            );
        });

        this.ws.on("error", (err) => {
            this.log.error(`WebSocket-Fehler: ${err.message}`);
        });
    }

    // Abonniere die Liste & Updates aller Activities
    subscribeActivities() {
        const msg = {
            kind: "req",
            id: 0,
            msg: "subscribe_events",
            msg_data: {
                channels: [ "entity_activity" ]
            }
        };
        this.log.info("Subscribe alle Activities auf der Remote 3  ...");
        this.ws.send(JSON.stringify(msg));
    }


    // WebSocket-Kommando: Alle Activities anfordern
    requestAllActivities() {
        const msg = {
            kind: "req",
            id: 0,
            msg: "get_entities",
            msg_data: {
                filter: { entity_types: [ "activity" ] }
            }
        };
        this.log.info("Fordere alle Activities von der Remote 3 an ...");
        this.ws.send(JSON.stringify(msg));
    }

    // Eingehende WS-Nachrichten verarbeiten
    async handleMessage(msg) {
        this.log.silly(`Empfangene WS-Nachricht: ${JSON.stringify(msg)}`);
        this.log.debug(`Empfangene WS-Nachricht: ${msg.msg}`);
        if (msg && msg.msg_data) {
            if (msg.kind === "resp" && msg.code === 200) {
                // Initiale Liste aller Aktivitäten
                if (msg.msg === "entities" && msg.msg_data.entities && Array.isArray(msg.msg_data.entities)) {
                    for (const act of msg.msg_data.entities) {
                        await this.createOrUpdateActivity(act);
                    }
                }
            }

            if (msg.kind === "event") {
                // Status-Update einer Aktivität
                if (msg.msg === "entity_change" && msg.cat === "ENTITY" && msg.msg_data && msg.msg_data.entity_type === "activity" 
                        && msg.msg_data.event_type === "CHANGE" && msg.msg_data.new_state) {
                    const act = msg.msg_data;
                    const id = act.entity_id.split(".")[2];
                    const nstate = act.new_state.attributes.state;
                    const isActive = nstate === "ON";
                    if (nstate === "ON" || nstate === "OFF") {
                        this.log.info(`Aktivität-Status geändert: ${id} => is_active=${isActive}`);
                        await this.setStateAsync(`activities.${id}.is_active`, isActive, true);
                    }
                }
            }
        }
    }

    // Hilfsfunktion: legt Activity-Objekte in ioBroker an
    async createOrUpdateActivity(act) {
        const id = act.entity_id.split(".")[2];
        const name = act.name.de_DE || act.name.en_US || id;

        this.extendObject(`activities.${id}`, {
            type: "channel",
            common: { name },
            native: {},
        });

        this.extendObject(`activities.${id}.is_active`, {
            type: "state",
            common: {
                name: "Activity aktiv?",
                type: "boolean",
                role: "indicator",
                read: true,
                write: false,
            },
            native: {},
        });
        this.setState(`activities.${id}.is_active`, act.attributes.state != "OFF", true);
        this.subscribeStates(`activities.${id}.start`);

        this.extendObject(`activities.${id}.start`, {
            type: "state",
            common: {
                name: "Starte diese Aktivität",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
    }

    // Wenn ioBroker-User eine Aktivität starten möchte
    async onStateChange(id, state) {
        this.log.debug(`StateChange: ${id} => ${JSON.stringify(state)}`);
        if (!state || state.ack) return;

        const parts = id.split(".");
        const actId = parts[parts.length - 2];
        const command = parts[parts.length - 1];

        if (command === "start" && state.val === true && this.connected) {
            this.log.info(`Starte Aktivität über WebSocket: ${actId}`);

            const msg = {
                kind: "req",
                id: 0,
                msg: "execute_entity_command",

                msg_data: {
                    entity_id: `uc.main.${actId}`,
                    cmd_id: "activity.start"
                }
            };

            try {
                this.ws.send(JSON.stringify(msg));
                this.log.info(`Startbefehl für '${actId}' gesendet.`);
            } catch (err) {
                this.log.error(`Fehler beim Senden von Startbefehl: ${err.message}`);
            }

            // Reset des Buttons nach kurzer Zeit
            setTimeout(() => this.setState(id, false, true), 500);
        }
    }

    onUnload(callback) {
        try {
            if (this.ws) this.ws.close();
            clearTimeout(this.reconnectTimeout);
            callback();
        } catch {
            callback();
        }
    }
}



if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Unfolded(options);
} else {
    // otherwise start the instance directly
    new Unfolded();
}