import { Stream } from './Stream';
import { OpenViduInternal } from './OpenViduInternal';
import { ParticipantInternal, ParticipantOptions } from './ParticipantInternal';
import EventEmitter = require('wolfy87-eventemitter');

export interface SessionOptions {
    sessionId: string;
    participantId: string;
    metadata: string;
    subscribeToStreams?: boolean;
    updateSpeakerInterval?: number;
    thresholdSpeaker?: number;
}

export class SessionInternal {

    private id: string;
    private ee = new EventEmitter();
    private streams = {};
    private participants = {};
    private participantsSpeaking: ParticipantInternal[] = [];
    private connected = false;
    private localParticipant: ParticipantInternal;
    private subscribeToStreams: boolean;
    private updateSpeakerInterval: number;
    public thresholdSpeaker: number;
    private options: SessionOptions

    constructor(private openVidu: OpenViduInternal, private sessionId: string) {
        this.localParticipant = new ParticipantInternal(this.openVidu, true, this);
    }



    /* NEW METHODS */
    connect(token, callback) {

        this.openVidu.connect((error) => {
            if (error) {
                callback('ERROR CONNECTING TO OPENVIDU');
            }
            else {

                let joinParams = {
                    token: token,
                    session: this.sessionId,
                    metadata: this.options.metadata,
                    dataChannels: false
                }

                if (this.localParticipant) {
                    if (Object.keys(this.localParticipant.getStreams()).some(streamId =>
                        this.streams[streamId].isDataChannelEnabled())) {
                        joinParams.dataChannels = true;
                    }
                }

                this.openVidu.sendRequest('joinRoom', joinParams, (error, response) => {

                    if (error) {
                        callback('UNABLE TO JOIN ROOM');
                    } else {

                        this.connected = true;

                        let exParticipants = response.value;

                        let roomEvent = {
                            participants: new Array<ParticipantInternal>(),
                            streams: new Array<Stream>()
                        }

                        let length = exParticipants.length;
                        for (let i = 0; i < length; i++) {

                            let participant = new ParticipantInternal(this.openVidu, false, this,
                                exParticipants[i]);

                            this.participants[participant.getId()] = participant;

                            roomEvent.participants.push(participant);

                            let streams = participant.getStreams();
                            for (let key in streams) {
                                roomEvent.streams.push(streams[key]);
                                if (this.subscribeToStreams) {
                                    streams[key].subscribe();
                                }
                            }
                        }

                        for (let part of roomEvent.participants) {
                            this.ee.emitEvent('connectionCreated', [{ connection: part }]);
                        }

                        //if (this.subscribeToStreams) {
                        for (let stream of roomEvent.streams) {
                            this.ee.emitEvent('stream-added', [{ stream }]);

                            // Adding the remote stream to the OpenVidu object
                            this.openVidu.getRemoteStreams().push(stream);
                        }
                        //}

                        callback(undefined);
                    }
                });
            }
        });
    }

    publish() {
        this.openVidu.getCamera().publish();
    }
    /* NEW METHODS */





    configure(options: SessionOptions) {

        this.options = options;
        this.id = options.sessionId;
        this.subscribeToStreams = options.subscribeToStreams == null ? true : options.subscribeToStreams;
        this.updateSpeakerInterval = options.updateSpeakerInterval || 1500;
        this.thresholdSpeaker = options.thresholdSpeaker || -50;
        this.localParticipant.setId(options.participantId);
        this.activateUpdateMainSpeaker();

        this.participants[options.participantId] = this.localParticipant;
    }

    getId() {
        return this.id;
    }

    getSessionId() {
        return this.sessionId;
    }

    private activateUpdateMainSpeaker() {

        setInterval(() => {
            if (this.participantsSpeaking.length > 0) {
                this.ee.emitEvent('update-main-speaker', [{
                    participantId: this.participantsSpeaking[this.participantsSpeaking.length - 1]
                }]);
            }
        }, this.updateSpeakerInterval);
    }

    getLocalParticipant() {
        return this.localParticipant;
    }

    addEventListener(eventName, listener) {
        this.ee.on(eventName, listener);
    }

    addOnceEventListener(eventName, listener) {
        this.ee.once(eventName, listener);
    }

    removeListener(eventName, listener) {
        this.ee.off(eventName, listener);
    }

    emitEvent(eventName, eventsArray) {
        this.ee.emitEvent(eventName, eventsArray);
    }


    subscribe(stream: Stream) {
        stream.subscribe();
    }

    unsuscribe(stream) {
        console.log("Unsubscribing from " + stream.getId());
        this.openVidu.sendRequest('unsubscribeFromVideo', {
            sender: stream.getId()
        },
            function (error, response) {
                if (error) {
                    console.error(error);
                } else {
                    console.info("Unsubscribed correctly from " + stream.getId());
                }
            });
    }

    onParticipantPublished(options) {

        let participant = new ParticipantInternal(this.openVidu, false, this, options);

        let pid = participant.getId();
        if (!(pid in this.participants)) {
            console.info("Publisher not found in participants list by its id", pid);
        } else {
            console.log("Publisher found in participants list by its id", pid);
        }
        //replacing old participant (this one has streams)
        this.participants[pid] = participant;

        this.ee.emitEvent('participant-published', [{ participant }]);

        let streams = participant.getStreams();
        for (let key in streams) {
            let stream = streams[key];

            if (this.subscribeToStreams) {
                stream.subscribe();
            }
            this.ee.emitEvent('stream-added', [{ stream }]);
            // Adding the remote stream to the OpenVidu object
            this.openVidu.getRemoteStreams().push(stream);
        }
    }

    onParticipantJoined(msg) {

        let participant = new ParticipantInternal(this.openVidu, false, this, msg);

        let pid = participant.getId();
        if (!(pid in this.participants)) {
            console.log("New participant to participants list with id", pid);
            this.participants[pid] = participant;
        } else {
            //use existing so that we don't lose streams info
            console.info("Participant already exists in participants list with " +
                "the same id, old:", this.participants[pid], ", joined now:", participant);
            participant = this.participants[pid];
        }

        this.ee.emitEvent('participant-joined', [{
            participant: participant
        }]);

        this.ee.emitEvent('connectionCreated', [{
            connection: participant
        }]);
        
    }

    onParticipantLeft(msg) {

        let participant = this.participants[msg.name];

        if (participant !== undefined) {
            delete this.participants[msg.name];

            this.ee.emitEvent('participant-left', [{
                participant: participant
            }]);

            let streams = participant.getStreams();
            for (let key in streams) {
                this.ee.emitEvent('stream-removed', [{
                    stream: streams[key],
                    preventDefault: () => { this.ee.removeEvent('stream-removed-default'); }
                }]);
                this.ee.emitEvent('stream-removed-default', [{
                    stream: streams[key]
                }]);

                // Deleting the removed stream from the OpenVidu object
                let index = this.openVidu.getRemoteStreams().indexOf(streams[key]);
                this.openVidu.getRemoteStreams().splice(index, 1);
            }

            participant.dispose();

        } else {
            console.warn("Participant " + msg.name
                + " unknown. Participants: "
                + JSON.stringify(this.participants));
        }
    };

    onParticipantEvicted(msg) {
        this.ee.emitEvent('participant-evicted', [{
            localParticipant: this.localParticipant
        }]);
    };

    onNewMessage(msg) {

        console.log("New message: " + JSON.stringify(msg));
        let room = msg.room;
        let user = msg.user;
        let message = msg.message;

        if (user !== undefined) {
            this.ee.emitEvent('newMessage', [{
                room: room,
                user: user,
                message: message
            }]);
        } else {
            console.warn("User undefined in new message:", msg);
        }
    }

    recvIceCandidate(msg) {

        let candidate = {
            candidate: msg.candidate,
            sdpMid: msg.sdpMid,
            sdpMLineIndex: msg.sdpMLineIndex
        }

        let participant = this.participants[msg.endpointName];
        if (!participant) {
            console.error("Participant not found for endpoint " +
                msg.endpointName + ". Ice candidate will be ignored.",
                candidate);
            return;
        }

        let streams = participant.getStreams();
        for (let key in streams) {
            let stream = streams[key];
            stream.getWebRtcPeer().addIceCandidate(candidate, function (error) {
                if (error) {
                    console.error("Error adding candidate for " + key
                        + " stream of endpoint " + msg.endpointName
                        + ": " + error);
                }
            });
        }
    }

    onRoomClosed(msg) {

        console.log("Room closed: " + JSON.stringify(msg));
        let room = msg.room;
        if (room !== undefined) {
            this.ee.emitEvent('room-closed', [{
                room: room
            }]);
        } else {
            console.warn("Room undefined in on room closed", msg);
        }
    }

    onLostConnection() {

        if (!this.connected) {
            console.warn('Not connected to room, ignoring lost connection notification');
            return;
        }

        console.log('Lost connection in room ' + this.id);
        let room = this.id;
        if (room !== undefined) {
            this.ee.emitEvent('lost-connection', [{ room }]);
        } else {
            console.warn('Room undefined when lost connection');
        }
    }

    onMediaError(params) {

        console.error("Media error: " + JSON.stringify(params));
        let error = params.error;
        if (error) {
            this.ee.emitEvent('error-media', [{
                error: error
            }]);
        } else {
            console.warn("Received undefined media error. Params:", params);
        }
    }

    /*
     * forced means the user was evicted, no need to send the 'leaveRoom' request
     */
    leave(forced, jsonRpcClient) {

        forced = !!forced;

        console.log("Leaving room (forced=" + forced + ")");

        if (this.connected && !forced) {
            this.openVidu.sendRequest('leaveRoom', function (error, response) {
                if (error) {
                    console.error(error);
                }
                jsonRpcClient.close();
            });
        } else {
            jsonRpcClient.close();
        }
        this.connected = false;
        if (this.participants) {
            for (let pid in this.participants) {
                this.participants[pid].dispose();
                delete this.participants[pid];
            }
        }
    }

    disconnect(stream: Stream) {

        let participant = stream.getParticipant();
        if (!participant) {
            console.error("Stream to disconnect has no participant", stream);
            return;
        }

        delete this.participants[participant.getId()];
        participant.dispose();

        if (participant === this.localParticipant) {

            console.log("Unpublishing my media (I'm " + participant.getId() + ")");
            delete this.localParticipant;
            this.openVidu.sendRequest('unpublishVideo', function (error, response) {
                if (error) {
                    console.error(error);
                } else {
                    console.info("Media unpublished correctly");
                }
            });

        } else {
            this.unsuscribe(stream);
        }
    }

    unpublish(stream: Stream) {

        let participant = stream.getParticipant();
        if (!participant) {
            console.error("Stream to disconnect has no participant", stream);
            return;
        }

        if (participant === this.localParticipant) {

            delete this.participants[participant.getId()];
            participant.dispose();

            console.log("Unpublishing my media (I'm " + participant.getId() + ")");
            delete this.localParticipant;
            this.openVidu.sendRequest('unpublishVideo', function (error, response) {
                if (error) {
                    console.error(error);
                } else {
                    console.info("Media unpublished correctly");
                }
            });
        }
    }

    getStreams() {
        return this.streams;
    }

    addParticipantSpeaking(participantId) {
        this.participantsSpeaking.push(participantId);
    }

    removeParticipantSpeaking(participantId) {
        let pos = -1;
        for (let i = 0; i < this.participantsSpeaking.length; i++) {
            if (this.participantsSpeaking[i] == participantId) {
                pos = i;
                break;
            }
        }
        if (pos != -1) {
            this.participantsSpeaking.splice(pos, 1);
        }
    }
}
