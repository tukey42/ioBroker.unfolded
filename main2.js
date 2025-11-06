/*
Updated ioBroker Adapter Template: unfoldedcircle-remote3
- Generates ALL entities (using original Unfolded Circle IDs)
- Hierarchical structure by type (activities, devices, inputs, services, actions, ...)
- Loads entities ONCE at startup (no continuous polling)
- Creates explicit action states under each entity; writing to an action state triggers REST POST to the action endpoint

Files included below:
- package.json
- io-package.json
- main.js
- README.md
*/

// ===== package.json =====
{
  "name": "iobroker.unfoldedcircle-remote3",
  "version": "0.1.0",
  "description": "ioBroker adapter for Unfolded Circle Remote 3 (REST)",
  "main": "main.js",
  "scripts": {
    "start": "node main.js"
  },
  "dependencies": {
    "@iobroker/adapter-core": "^4.0.0",
    "axios": "^1.4.0",
    "ws": "^8.12.0"
  }
}

// ===== io-package.json =====
{
  "common": {
    "name": "unfoldedcircle-remote3",
    "version": "0.1.0",
    "title": "Unfolded Circle Remote 3",
    "desc": "Integrates Remote 3 via local WebServices API - creates all entities hierarchically using original IDs",
    "platform": "Javascript/Node.js",
    "mode": "daemon",
    "enabled": true,
    "keywords": ["unfolded","remote","remote3"],
    "readme": "README.md",
    "loglevel": "info"
  },
  "native": {
    "host": "192.168.1.50",
    "port": 80,
    "useWs": false,
    "wsPath": "/ws"
  }
}

// ===== main.js =====
const { Adapter } = require('@iobroker/adapter-core');
const axios = require('axios');

class UnfoldedAdapter extends Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'unfoldedcircle-remote3' });
        this.restBase = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        this.log.info('Adapter ready — loading all entities once (original IDs)');

        const host = this.config.host || this.native?.host || '127.0.0.1';
        const port = this.config.port || this.native?.port || 80;
        const protocol = (port === 443) ? 'https' : 'http';

        this.restBase = `${protocol}://${host}:${port}`;

        // basic states
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {}
        });
        await this.setStateAsync('info.connection', { val: false, ack: true });

        await this.setObjectNotExistsAsync('meta.api', {
            type: 'state',
            common: { name: 'api_meta', type: 'string', role: 'info', read: true, write: false },
            native: {}
        });

        try {
            const entities = await this._fetchEntitiesOnce();
            await this._createObjectsForEntities(entities);
            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.log.info('All entities created (once)');
        } catch (err) {
            this.log.error('Failed to load entities: ' + err.message);
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    async _fetchEntitiesOnce() {
        const url = `${this.restBase}/api/v1/entities`;
        this.log.debug('Fetching entities from ' + url);
        const res = await axios.get(url, { timeout: 8000 });
        const data = res.data;
        await this.setStateAsync('meta.api', { val: JSON.stringify({ fetchedAt: new Date().toISOString(), count: Array.isArray(data) ? data.length : 0 }), ack: true });
        if (!Array.isArray(data)) {
            throw new Error('Unexpected entities response (not an array)');
        }
        return data;
    }

    // Create a hierarchical object structure grouped by entity.type and using original IDs
    async _createObjectsForEntities(entities) {
        // group by type
        const groups = {};
        for (const ent of entities) {
            const t = ent.type || 'unknown';
            if (!groups[t]) groups[t] = [];
            groups[t].push(ent);
        }

        // for each type create folder
        for (const [type, list] of Object.entries(groups)) {
            const folderId = `${type}`; // top-level folder name
            await this.setObjectNotExistsAsync(folderId, {
                type: 'channel',
                common: { name: type },
                native: {}
            });

            for (const ent of list) {
                // use original ID as-is (replace dots with underscores for ioBroker object ID naming rules)
                const origId = String(ent.id || ent.key || ent.uuid || ent._id || ent.name);
                const safeId = origId.replace(/[^a-zA-Z0-9_\-]/g, '_');
                const base = `${folderId}.${safeId}`;

                // create channel for entity
                await this.setObjectNotExistsAsync(base, {
                    type: 'channel',
                    common: { name: ent.name || origId },
                    native: { unfolded_original_id: origId }
                });

                // meta state
                await this.setObjectNotExistsAsync(`${base}.meta`, {
                    type: 'state',
                    common: { name: 'metadata', type: 'string', role: 'info', read: true, write: false },
                    native: {}
                });
                await this.setStateAsync(`${base}.meta`, { val: JSON.stringify(ent), ack: true });

                // primary state if exists (e.g., entity.state)
                if (ent.state !== undefined) {
                    const stType = typeof ent.state === 'number' ? 'number' : typeof ent.state === 'boolean' ? 'boolean' : 'string';
                    await this.setObjectNotExistsAsync(`${base}.state`, {
                        type: 'state',
                        common: { name: 'state', type: stType, role: 'value', read: true, write: false },
                        native: {}
                    });
                    await this.setStateAsync(`${base}.state`, { val: ent.state, ack: true });
                }

                // attributes folder (if attributes exist)
                if (ent.attributes && typeof ent.attributes === 'object') {
                    await this.setObjectNotExistsAsync(`${base}.attributes`, { type: 'channel', common: { name: 'attributes' }, native: {} });
                    for (const [k, v] of Object.entries(ent.attributes)) {
                        const t = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
                        await this.setObjectNotExistsAsync(`${base}.attributes.${k}`, {
                            type: 'state',
                            common: { name: k, type: t, role: 'info', read: true, write: false },
                            native: {}
                        });
                        await this.setStateAsync(`${base}.attributes.${k}`, { val: v, ack: true });
                    }
                }

                // actions (explicit states) - create a writable boolean/command per action
                // We'll look for ent.actions array or ent.available_actions
                const actions = Array.isArray(ent.actions) ? ent.actions : (Array.isArray(ent.available_actions) ? ent.available_actions : []);
                if (actions.length > 0) {
                    await this.setObjectNotExistsAsync(`${base}.actions`, { type: 'channel', common: { name: 'actions' }, native: {} });
                    for (const action of actions) {
                        // Action can be a string name or object { name, schema }
                        const actionName = (typeof action === 'string') ? action : (action.name || action.id || JSON.stringify(action));
                        const safeAction = String(actionName).replace(/[^a-zA-Z0-9_\-]/g, '_');
                        const objId = `${base}.actions.${safeAction}`;

                        // Create writable state to trigger action. Use 'string' to pass payload JSON or simple 'boolean' to trigger without payload
                        await this.setObjectNotExistsAsync(objId, {
                            type: 'state',
                            common: { name: actionName, type: 'string', role: 'button', read: false, write: true },
                            native: {}
                        });
                        // no initial state set (write-only trigger)
                    }
                }

                // Additional helpful states
                await this.setObjectNotExistsAsync(`${base}.lastUpdate`, {
                    type: 'state',
                    common: { name: 'last update', type: 'string', role: 'info.timestamp', read: true, write: false },
                    native: {}
                });
                await this.setStateAsync(`${base}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }
        }
    }

    // Handle writes to action states
    async onStateChange(id, state) {
        if (!state || state.ack) return; // ignore acked or null
        this.log.debug(`stateChange ${id} -> ${JSON.stringify(state)}`);

        // match pattern: <type>.<origId>*.actions.<action>
        const m = id.match(/^([^.]+)\.([^.]+)\.actions\.([^.]+)$/);
        if (!m) return;
        const type = m[1];
        const safeOrigId = m[2];
        const actionSafe = m[3];

        // we stored original id in native of channel earlier; try to fetch it
        try {
            const channelObj = await this.getForeignObjectAsync(`${type}.${safeOrigId}`);
            let origId = null;
            if (channelObj && channelObj.native && channelObj.native.unfolded_original_id) origId = channelObj.native.unfolded_original_id;
            if (!origId) {
                // fallback: use safeOrigId (may work if original was safe already)
                origId = safeOrigId;
            }

            const actionName = actionSafe.replace(/_/g, ' '); // best-effort human name

            // Prepare payload: try parse JSON from state.val, else send empty body
            let body = {};
            if (typeof state.val === 'string' && state.val.trim()) {
                try { body = JSON.parse(state.val); } catch (e) { body = { value: state.val }; }
            }

            const url = `${this.restBase}/api/v1/entities/${encodeURIComponent(origId)}/actions/${encodeURIComponent(actionName)}`;
            this.log.info(`Calling action ${actionName} for entity ${origId} -> ${url}`);

            // POST the action
            const res = await axios.post(url, body, { timeout: 8000 });
            this.log.debug(`Action result status ${res.status}`);

            // set lastUpdate and ack the trigger state
            await this.setStateAsync(id, { val: state.val, ack: true });
            const baseChannel = `${type}.${safeOrigId}`;
            await this.setStateAsync(`${baseChannel}.lastUpdate`, { val: new Date().toISOString(), ack: true });

        } catch (err) {
            this.log.error('Action call failed: ' + err.message);
            // Do NOT ack the state so user can retry; write an error state
            const errId = `${id}_error`;
            await this.setObjectNotExistsAsync(errId, { type: 'state', common: { name: 'last action error', type: 'string', role: 'text', read: true, write: false }, native: {} });
            await this.setStateAsync(errId, { val: err.message, ack: true });
        }
    }

    async onUnload(callback) {
        try {
            this.log.info('Adapter stopped');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main === module) {
    new UnfoldedAdapter();
}

// ===== README.md =====

# iobroker.unfoldedcircle-remote3 (enhanced)

Dieses Template erstellt beim Start **einmalig** alle Entities, gruppiert nach ihrem `type`.

- Verwendet die **originalen IDs** der Unfolded Circle Entities (im ioBroker-Objektnamen werden Sonderzeichen ersetzt durch `_`).
- Legt für jede Entity eine `meta`-State, ggf. `state`, `attributes`-Unterstates sowie eine `actions`-Gruppe mit expliziten, beschreibbaren Action-States an.
- Schreiben in einen Action-State löst einen **POST** an `/api/v1/entities/<origId>/actions/<action>` aus. Der State wird nur bei Erfolg als `ack: true` gesetzt.

## Anpassungen / ToDos
- Authentifizierung: Falls dein Remote Auth erfordert, muss axios-Instanz mit Headern/Token ergänzt werden.
- Schema-Validierung: Optional könnten wir Action-States typisieren (boolean/string/object) basierend auf API-Schema.
- Fehlerbehandlung: derzeit wird bei Fehlern ein `<state>_error` geschrieben.

Viel Erfolg — sag Bescheid, wenn ich Auth, better naming, oder TypeScript-Conversion einbauen soll.
