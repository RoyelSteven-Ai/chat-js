// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { Chat } from "jsdelivr.gh:ChatOnMac/chat-js@4f2b0a3/chat/modules/chat.js";
// import { Chat } from "https://github.com/ChatOnMac/chat-js/blob/main/chat/modules/chat.js";

// Copied from module for import map rigging... temporary hack.
// Dev Mode:
//addRxPlugin(RxDBDevModePlugin);

// From: https://github.com/kofrasa/mingo/tree/49f6f98e2432c9f389cd65e4a7e27f4e004c6a26#loading-operators
// Note that doing this effectively imports the entire library into your bundle and unused operators cannot be tree shaked
//import "esm.run:mingo/init/system";

// This will be cleaned up for easier reuse soon. --ChatOnMac

// import { proxyConsole } from "jsdelivr.gh:ChatOnMac/chat-js@main/chat/modules/console-proxy.js";

import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "npm:rxdb";
import { RxDBDevModePlugin } from "npm:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "npm:rxdb/plugins/replication";
import { getRxStorageMemory } from "npm:rxdb/plugins/storage-memory";
import { createDeferredExecutor } from "esm.run:@open-draft/deferred-promise";
import { until } from "esm.run:@open-draft/until";
import { Emitter } from "esm.run:strict-event-emitter";
import { Logger } from "esm.run:@open-draft/logger";
import { invariant } from "esm.run:outvariant";
import { isNodeProcess } from "esm.run:is-node-process";
import { BatchInterceptor } from 'esm.run:@mswjs/interceptors@0.25.4';
import browserInterceptors from 'esm.run:@mswjs/interceptors@0.25.4/lib/browser/presets/browser.mjs';

// addRxPlugin(RxDBDevModePlugin);
function installNativeHostBehaviors() {
    const interceptor = new BatchInterceptor({
        name: 'my-interceptor',
        interceptors: browserInterceptors,
    })
    interceptor.on('request', listener)
}

/**
 * The conflict handler gets 3 input properties:
 * - assumedMasterState: The state of the document that is assumed to be on the master branch
 * - newDocumentState: The new document state of the fork branch (=client) that RxDB want to write to the master
 * - realMasterState: The real master state of the document
 */
function conflictHandler(i) {
    /**
     * Here we detect if a conflict exists in the first place.
     * If there is no conflict, we return isEqual=true.
     * If there is a conflict, return isEqual=false.
     * In the default handler we do a deepEqual check,
     * but in your custom conflict handler you probably want
     * to compare specific properties of the document, like the updatedAt time,
     * for better performance because deepEqual() is expensive.
     */
    if (deepEqual(
        i.newDocumentState,
        i.realMasterState
    )) {
        return Promise.resolve({
            isEqual: true
        });
    }

    /**
     * If a conflict exists, we have to resolve it.
     * The default conflict handler will always
     * drop the fork state and use the master state instead.
     * 
     * In your custom conflict handler you likely want to merge properties
     * of the realMasterState and the newDocumentState instead.
     */
    return Promise.resolve({
        isEqual: false,
        documentData: i.newDocumentState.modifiedAt > i.realMasterState.modifiedAt ? i.realMasterState : i.newDocumentState,
    });
}

class ChatParentBridge {
    db;
    state;
    onFinishedSyncingDocsFromCanonical;

    constructor ({ db, state, onFinishedSyncingDocsFromCanonical }) {
        this.db = db;
        this.state = state;
        this.onFinishedSyncingDocsFromCanonical = onFinishedSyncingDocsFromCanonical;
    }

    async createReplicationState(collection) {
        const { name: collectionName } = collection;
    
        const pullHandler = async (lastCheckpoint, batchSize) => {
            // console.log("Called pull handler with: ", lastCheckpoint, batchSize);

            const canonicalDocumentChangesKey =
                this.getCanonicalDocumentChangesKey(collectionName);
            var documents = [];
            for (let i = 0; i < batchSize; i++) {
                const el = (this.state.canonicalDocumentChanges[canonicalDocumentChangesKey] || []).shift();
                if (el) {
                    documents.push(el);
                } else {
                    break;
                }
            }

            const checkpoint =
                documents.length === 0
                    ? lastCheckpoint
                    : {
                        id: lastOfArray(documents).id,
                        modifiedAt: lastOfArray(documents).modifiedAt,
                    };

            window[`${collectionName}LastCheckpoint`] = checkpoint;

            return {
                documents,
                checkpoint,
            };
        };

        const replicationState = replicateRxCollection({
            collection,
            replicationIdentifier: `${collectionName}-replication`,
            live: true,
            retryTime: 5 * 1000,
            waitForLeadership: true,
            autoStart: true,
    
            deletedField: "isDeleted",
    
            push: {
                async handler(docs) {
                    //console.log("Called push handler with: ", docs);
                    window.webkit.messageHandlers.surrogateDocumentChanges.postMessage({
                        collectionName: collection.name,
                        changedDocs: docs.map((row) => {
                            return row.newDocumentState;
                        }),
                    });
    
                    return [];
                },
                batchSize: 50,
                modifier: (doc) => doc,
            },
    
            pull: {
                handler: pullHandler.bind(this),
                batchSize: 10,
                modifier: (doc) => doc,
            },
        });
    
        return replicationState;
    }

    getReplicationStateKey(collectionName) {
        return `${collectionName}ReplicationState`;
    }
    
    getCanonicalDocumentChangesKey(collectionName) {
        return `${collectionName}CanonicalDocumentChanges`;
    }
    
    async createCollectionsFromCanonical(collections) {
        console.log("create CAn From Can")
        for (const [collectionName, collection] of Object.entries(collections)) {
            collections[collectionName]["conflictHandler"] = conflictHandler;
        }
        console.log(collections)
        await this.db.addCollections(collections);

        const collectionEntries = Object.entries(this.db.collections);
        for (const [collectionName, collection] of collectionEntries) {
            const replicationState = await this.createReplicationState(collection);
            const replicationStateKey = this.getReplicationStateKey(collectionName);
            this.state.replications[replicationStateKey] = replicationState;
        }

        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
            await replicationState.awaitInSync();
        }
        console.log("create CAn From Can - ova")
    }

    async syncDocsFromCanonical(collectionName, changedDocs) {
        const replicationStateKey = this.getReplicationStateKey(collectionName);
        const replicationState = this.state.replications[replicationStateKey];
    
        const canonicalDocumentChangesKey =
            this.getCanonicalDocumentChangesKey(collectionName);
    
        if (!this.state.canonicalDocumentChanges[canonicalDocumentChangesKey]) {
            this.state.canonicalDocumentChanges[canonicalDocumentChangesKey] = [];
        }
        this.state.canonicalDocumentChanges[canonicalDocumentChangesKey].push(...changedDocs);
    
        replicationState.reSync();
        await replicationState.awaitInSync();
    }

    async replicationInSync() {
        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
            await replicationState.awaitInSync();
        }
    }

    async finishedSyncingDocsFromCanonical() {
        console.log("finishedSyncingDocsFromCan()")
        for (const replicationState of Object.values(this.state.replications)) {
            replicationState.reSync();
        }
        await this.replicationInSync()
    
        await this.onFinishedSyncingDocsFromCanonical();
        console.log("eh2")
    }
}

class Chat extends EventTarget {
    db;
    parentBridge;

    onlineAt = new Date();
    state = { replications: {}, canonicalDocumentChanges: {} };

    constructor ({ db }) {
        super();
        this.db = db;
        const onFinishedSyncingDocsFromCanonical = this.onFinishedSyncingDocsFromCanonical.bind(this);
        this.parentBridge = new ChatParentBridge({ db, state: this.state, onFinishedSyncingDocsFromCanonical, dispatchEvent: this.dispatchEvent });
    }

    async onFinishedSyncingDocsFromCanonical() {
        console.log("on finish 1")
        this.dispatchEvent(new CustomEvent("finishedInitialSync", { detail: { db: this.db, replications: this.state.replications } }));
        console.log("on finish 2")
        await this.keepOwnPersonasOnline();
        console.log("on finish 3")
        // this.offerUnusedPersonas = this.offerUnusedPersonas.bind(this);
        // await this.offerUnusedPersonas();
        // this.dispatchEvent(new CustomEvent("offerUnusedPersonas", { detail: { } }));
        await this.wireUnusedPersonas();
        console.log("on finish 4")
    }

    static async init() {
        // proxyConsole();

        const db = await createRxDatabase({
            name: "chat",
            storage: getRxStorageMemory(),
            eventReduce: true,
            multiInstance: false, // Change this when ported to web etc.
        });

        // Invoke the private constructor...
        const chat = new Chat({ db });
        return chat;
    }

    async dispatchUnusedPersonasEvent(rooms) {
        var rooms = rooms || await this.db.collections.room.find().exec();
        const botsInRoomsIDs = [...new Set(rooms.flatMap(room => room.participants))];
        const botsInRooms = await this.db.collections.persona.findByIds(botsInRoomsIDs).exec();
        const unusedOnlineBots = await this.db.collections.persona.find({ selector: { $not: { id: { $in: botsInRoomsIDs } } } }).exec();
        // await offerUnusedPersonas({ botsInRooms, unusedOnlineBots });
        this.dispatchEvent(new CustomEvent("offerUnusedPersonas", { detail: { db: this.db, botsInRooms, unusedOnlineBots } }));
    }

    async wireUnusedPersonas() {
        if (this.db.collections.length === 0) { return }
        await this.db.collections.room.$.subscribe(async rooms => {
            this.dispatchUnusedPersonasEvent();
        });
        this.dispatchUnusedPersonasEvent();
    }

    async ownPersonas() {
        // TODO: Multiple bots in same room.
        const botPersonas = await this.getBotPersonas(null);
        return botPersonas
    }
    
    async keepOwnPersonasOnline() {
        console.log("KEEP own online")
        if (this.db.collections.length === 0) { return }
        console.log("KEEP own online - 0")
        const botPersonas = await this.ownPersonas();
        console.log("KEEP own online - 1")
        for (const botPersona of botPersonas) {
            if (!botPersona.online) {
        console.log("KEEP own online - updatin one..")
                // Refresh instance (somehow stale otherwise).
                let bot = await this.db.collections["persona"].findOne(botPersona.id).exec();
                await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
            }
            // TODO: unsubscribe too is necessary with rxdb
            botPersona.online$.subscribe(async online => {
                if (!online) {
        console.log("KEEP own online - sub resp..")
                    // Refresh instance (somehow stale otherwise).
                    let bot = await this.db.collections["persona"].findOne(botPersona.id).exec();
                    await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
                }
            });
        }
        console.log("KEEP own online - end")
    }

    async getBotPersonas(room) {
        if (this.db.collections.length === 0) { return }
        let extension = await this.db.collections["code_extension"].findOne().exec();
        let botPersonas = await this.getProvidedBotsIn(extension, room);
        if (botPersonas.length > 0) {
            return botPersonas;
        }
    
        let allRooms = await this.db.collections["room"].find().exec();
        var bots = [];
        for (const otherRoom of allRooms) {
            botPersonas = await this.getProvidedBotsIn(extension, otherRoom);
            if (botPersonas.length > 0) {
                bots.push(...botPersonas);
            }
        }
        if (bots.length > 0) {
            return bots;
        }
    
        //console.log(this.db.collections["persona"])
//console.log(this.db.collections["persona"].findOne({ selector: { personaType: "bot" } }))
        const botPersona = await this.db.collections["persona"]
            .findOne({ selector: { personaType: "bot" } })
            .exec();
        if (!botPersona) {
            return [];
        }
        return [botPersona];
    }

    async getProvidedBotsIn(extension, room) {
        if (this.db.collections.length === 0) { return [] }
        var bots = [];
        if (room && room.participants && room.participants.length > 0) {
            let allInRoomMap = await this.db.collections["persona"].findByIds(room.participants).exec();
            for (const participant of allInRoomMap.values()) {
                if (participant.providedByExtension === extension.id && participant.personaType === "bot") {
                    bots.push(participant);
                }
            }
        }
        return bots;
    }
}

// export { Chat, installNativeHostBehaviors };








async function offerUnusedPersonas ({ db, botsInRooms, unusedOnlineBots }) {
    console.log("well2hehehe...")
    // console.log("OFFER UNUSED?");
    if (unusedOnlineBots.length > 0) {
    // console.log("OFFER UNUSED? nah");
        return [];
    }
    // console.log("OFFER UNUSED? yah")
    const botPersona = await db.collections["persona"].insert({
        id: crypto.randomUUID(),
        name: "ChatBOT",
        personaType: "bot",
        online: true,
        modelOptions: ["gpt-3.5-turbo", "gpt-4"],
        modifiedAt: new Date().getTime(),
    });
    // console.log("OFFER UNUSED? yah go")
    return [botPersona];
}

const chat = await Chat.init();
window.chat = chat;
window.chat.addEventListener("offerUnusedPersonas", offerUnusedPersonas);

chat.addEventListener("finishedInitialSync", (event) => {
    console.log("finishedInitialSync");
    const db = event.detail.db;
    const replications = event.detail.replications;
    db.collections.event.insert$.subscribe(async ({ documentData, collectionName }) => {
        if (documentData.createdAt < EPOCH.getTime()) {
            return;
        }
        const personaCollection = db.collections["persona"];
        const persona = await personaCollection
            .findOne(documentData.sender)
            .exec();
        if (persona?.personaType !== "user") {
            return;
        }

        // Build message history.
        const messages = await collection
            .find({
                selector: {
                    room: documentData.room,
                },
                limit: 10, // TODO: This is constrained by the model's token limit.
                sort: [{ createdAt: "desc" }],
            })
            .exec();

        const messageHistory = await Promise.all(
            messages.map(async ({ content, persona }) => {
                const foundPersona = await personaCollection
                    .findOne(persona)
                    .exec();
                return {
                    role:
                    foundPersona.personaType === "bot" ? "assistant" : "user",
                    content,
                };
            })
        );
        messageHistory.sort((a, b) => b - a);
        const room = await db.collections["room"].findOne(documentData.room).exec();
        const botPersonas = await getBotPersonas(room);
        const botPersona = botPersonas.length ? botPersonas[0] : null;
        if (!botPersona) {
            console.log("No matching bot to emit from.")
            return;
        }

        if (!botPersona.selectedModel) {
            botPersona.selectedModel = botPersona.modelOptions[0];
        }

        var systemPrompt = "";
        if (botPersona.customInstructionForContext || botPersona.customInstructionForReplies) {
            if (botPersona.customInstructionForContext) {
                systemPrompt += botPersona.customInstructionForContext.trim() + "\n\n"
            }
            if (botPersona.customInstructionForResponses) {
                systemPrompt += botPersona.customInstructionForResponses.trim() + "\n\n"
            }
        } else {
            systemPrompt = "You are a helpful assistant.";
        }
        systemPrompt = systemPrompt.trim();

        try {
            const resp = await fetch(
                "code://code/load/api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Chat-Trace-Event": documentData.id,
                    },
                    body: JSON.stringify({
                        model: botPersona.selectedModel,
                        temperature: botPersona.modelTemperature,
                        messages: [
                            {
                                role: "system",
                                content: systemPrompt,
                            },
                            ...messageHistory,
                            {
                                role: "user",
                                content: documentData.content,
                            },
                        ],
                    }),
                }
            );

            const data = await resp.json();

            if (!resp.ok) {
                 if (data.error.code === 'context_length_exceeded') {
                    
                 }

                throw new Error(data.error.message);
            }

            const content = data.choices[0].message.content;
            const createdAt = new Date().getTime();

            collection.insert({
                id: crypto.randomUUID(),
                content,
                type: "message",
                room: documentData.room,
                sender: botPersona.id,
                createdAt,
                modifiedAt: createdAt,
            });
        } catch (error) {
            var eventDoc = await db.collections.event.findOne(documentData.id).exec();
            await eventDoc.incrementalModify((docData) => {
                docData.failureMessages = docData.failureMessages.concat(error);
                docData.retryablePersonaFailures = docData.retryablePersonaFailures.concat(botPersona.id);
                return docData;
            });
        }
    });
});
