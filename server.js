require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// STATE & CONSTANTS
// ==========================================
let players = {};
let gameState = 'LOGIN';
let roundNumber = 0;
let gameConfig = {};
let hostSocketId = null;
global.gameTheme = 'default';

const DEFAULT_WEAPONS = ['Knife', 'Candlestick', 'Revolver', 'Rope', 'Poison', 'Wrench'];
const DEFAULT_LOCATIONS = ['Hall', 'Lounge', 'Dining Room', 'Kitchen', 'Ballroom', 'Conservatory', 'Library'];
let activeWeapons = [];
let activeLocations = [];
let trueMurderer = null;
let trueWeapon = null;
let trueLocation = null;

let interrogationQueue = [];
let currentInterrogatorId = null;
let currentInterrogationState = {};

let phaseEndTime = 0;
let phaseTimeoutId = null;
let nightTimerEndTime = 0;

let dayVotes = {};
let finaleGuesses = {};
let readyPlayers = new Set();

// Advanced Role State
let vigilanteBullets = {};
let activeVoodooCurse = null;
let jammedPlayers = new Set();
let nightActions = {};
let nightSequence = [];
let currentNightRole = null;
let nightTimerTimeout = null;
let expectedNightSubmissions = 0;
let currentNightSubmissions = 0;
let nightTurnActive = false; // IRONCLAD LOCK FOR ASYNC RACE CONDITIONS

// Server-side clue board state, keyed by playerId -> { itemName: stateIndex }
let clueBoardState = {};

// Game event log for post-game recap
let gameLog = [];

// ==========================================
// HELPERS
// ==========================================
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
function getPlayerBySocket(sockId) { return Object.values(players).find(p => p.socketId === sockId); }
function narratorBroadcast(message, isNight = false) { io.emit('narrator_event', { msg: message, isNight }); }
function isMafiaTeam(role) { return ['Mafia', 'Godfather', 'Framer', 'Voodoo Lady', 'Logic Jammer', 'Consigliere', 'Mafia Murderer', 'Mafia Accomplice'].includes(role); }
function roleInGame(role) { return Object.values(players).some(p => p.role === role); }
function broadcastGraveyard() { io.emit('graveyard_update', Object.values(players).map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, role: p.isAlive ? null : (gameConfig.blindExecutions ? '???' : p.role) }))); }
function logEvent(type, description) { gameLog.push({ round: roundNumber, type, description }); }

function calculateTTSDuration(text) {
    const wordCount = text.split(/\s+/).length;
    return Math.ceil((wordCount / 2.5) * 1000) + 1500;
}
async function narratorBroadcastAndWait(message, isNight = false) {
    narratorBroadcast(message, isNight);
    await new Promise(resolve => setTimeout(resolve, calculateTTSDuration(message)));
}

// Build the display role tag for a player (used in multiple places)
function getDisplayRole(player) {
    if (player.role === 'Mafia') {
        return player.id === trueMurderer ? 'Mafia Murderer' : 'Mafia Accomplice';
    }
    return player.role;
}

// ==========================================
// AI NARRATOR
// ==========================================
async function getAIStory(theme, contextPrompt, retries = 2) {
    const activeTheme = theme || 'classic mystery';
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];
    const modelQueue = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash-lite-001'];
    const prompt = `You are the dramatic narrator of a Mafia/Clue mystery game. Theme: "${activeTheme}". ${contextPrompt} Write a highly atmospheric 2 to 3 sentence story. No quotes.`;

    for (let i = 0; i <= retries; i++) {
        const modelName = modelQueue[i % modelQueue.length];
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        try {
            console.log(`[AI Narrator] Using ${modelName}... (Attempt ${i + 1})`);
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        } catch (e) {
            console.log(`[AI Narrator] ${modelName} failed: ${e.message.split(']')[0]}]`);
            if (i < retries) await new Promise(resolve => setTimeout(resolve, 2000));
            else return 'A chill hangs in the air as the events unfold...';
        }
    }
}

// ==========================================
// GENERATE UNIQUE MAFIA CLUE
// Guards against empty pool (Bug J fix)
// ==========================================
function generateUniqueMafiaClue() {
    const weaponPool = activeWeapons.filter(w => w !== trueWeapon);
    const locationPool = activeLocations.filter(l => l !== trueLocation);
    const useWeapon = weaponPool.length > 0 && (locationPool.length === 0 || Math.random() > 0.5);
    if (useWeapon) return `🔎 Clue: The true weapon is NOT the ${weaponPool[Math.floor(Math.random() * weaponPool.length)]}.`;
    if (locationPool.length > 0) return `🔎 Clue: The murder did NOT happen in the ${locationPool[Math.floor(Math.random() * locationPool.length)]}.`;
    return `🔎 Clue: The investigation continues...`;
}

// ==========================================
// FULL STATE RESET
// Used by both reset_game and start_game
// ==========================================
function resetGameState() {
    roundNumber = 0;
    interrogationQueue = [];
    dayVotes = {};
    finaleGuesses = {};
    nightActions = {};
    nightSequence = [];
    currentNightRole = null;
    activeVoodooCurse = null;
    jammedPlayers.clear();
    currentInterrogationState = {};
    nightTurnActive = false;
    vigilanteBullets = {};
    clueBoardState = {};
    gameLog = [];
    clearTimeout(phaseTimeoutId);
    clearTimeout(nightTimerTimeout);
}

// ==========================================
// CORE SOCKET LOGIC
// ==========================================
io.on('connection', (socket) => {

    // ------------------------------------------
    // HOST & LOBBY
    // ------------------------------------------
    socket.on('claim_host', () => {
        if (!hostSocketId) {
            hostSocketId = socket.id;
            io.to(socket.id).emit('host_success');
            io.to(socket.id).emit('phase_change', gameState);
            io.emit('update_players', Object.values(players));
        }
    });

    socket.on('join_lobby', (data) => {
        players[data.id] = { id: data.id, socketId: socket.id, name: data.name, role: null, isAlive: true };
        io.emit('update_players', Object.values(players));
    });

    socket.on('rejoin_attempt', (playerId) => {
        const player = players[playerId];
        if (!player || gameState === 'LOGIN' || gameState === 'LOBBY') return;

        player.socketId = socket.id;
        if (isMafiaTeam(player.role)) socket.join('mafia_room');

        io.to(socket.id).emit('rejoin_success', player);
        io.to(socket.id).emit('phase_change', gameState);
        io.to(socket.id).emit('role_assigned', {
            displayRole: getDisplayRole(player),
            coreRole: player.role,
            playerList: Object.values(players),
            weapons: activeWeapons,
            locations: activeLocations
        });
        broadcastGraveyard();

        // Restore server-side clue board state
        if (clueBoardState[playerId]) {
            io.to(socket.id).emit('restore_clue_board', clueBoardState[playerId]);
        }

        // Restore intro chat if reconnecting during Mafia's window
        if (gameState === 'INTRO' && isMafiaTeam(player.role)) {
            const remaining = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
            const mafiaRoster = Object.values(players)
                .filter(p => isMafiaTeam(p.role))
                .map(p => `${p.name} (${getDisplayRole(p)})`)
                .join(', ');
            io.to(socket.id).emit('open_mafia_intro_chat', { roster: mafiaRoster, time: remaining });
        }

        if (gameState === 'INTERROGATION' && currentInterrogationState.status) {
            const reconnectState = { ...currentInterrogationState };
            if (reconnectState.status === 'TICKING') {
                reconnectState.duration = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
                io.to(socket.id).emit('interrogation_update', reconnectState);
                if (reconnectState.activePlayerId === playerId) {
                    const list = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
                    io.to(socket.id).emit('prompt_clue_guess', { weapons: activeWeapons, locations: activeLocations, playerList: list });
                }
            } else {
                io.to(socket.id).emit('interrogation_update', reconnectState);
            }
        } else if (gameState === 'DAY' || gameState === 'DAY_VOTE') {
            const remaining = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
            if (gameState === 'DAY') io.to(socket.id).emit('start_day_timer', remaining);
            if (gameState === 'DAY_VOTE') {
                io.to(socket.id).emit('start_day_vote_timer', remaining);
                const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
                if (!dayVotes[playerId] && players[playerId].isAlive) io.to(socket.id).emit('prompt_day_vote', aliveList);
            }
        } else if (gameState === 'NIGHT' && player.isAlive && currentNightRole) {
            let validTargets = Object.values(players).filter(p => p.isAlive);
            if (currentNightRole === 'Voodoo Lady') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));
            const remaining = Math.max(0, Math.round((nightTimerEndTime - Date.now()) / 1000));
            if ((currentNightRole === 'Mafia' && isMafiaTeam(player.role)) || currentNightRole === player.role) {
                io.to(socket.id).emit('night_action_phase', { role: currentNightRole, time: remaining, players: validTargets.map(p => ({ id: p.id, name: p.name })), weapons: activeWeapons, locations: activeLocations });
            }
        } else if (gameState === 'FINALE' && player.isAlive) {
            io.to(socket.id).emit('prompt_finale_guess', { weapons: activeWeapons, locations: activeLocations, playerList: Object.values(players) });
        }
    });

    socket.on('mafia_chat', (msg) => {
        const p = getPlayerBySocket(socket.id);
        if (p && isMafiaTeam(p.role)) io.to('mafia_room').emit('mafia_chat_update', { sender: p.name, msg });
    });

    // Intro-phase Mafia chat with role tag — only active during INTRO gameState
    socket.on('mafia_intro_chat', (msg) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !isMafiaTeam(p.role) || gameState !== 'INTRO') return;
        io.to('mafia_room').emit('mafia_intro_chat_update', { sender: p.name, roleTag: getDisplayRole(p), msg });
    });

    socket.on('player_ready', () => {
        const p = getPlayerBySocket(socket.id);
        if (p && p.isAlive && gameState === 'DAY') {
            readyPlayers.add(p.id);
            const aliveCount = Object.values(players).filter(pl => pl.isAlive).length;
            io.emit('ready_count_update', readyPlayers.size, aliveCount);
            if (readyPlayers.size >= aliveCount) { clearTimeout(phaseTimeoutId); startDayVoting(); }
        }
    });

    // Server-side clue board persistence
    socket.on('update_clue_board', (data) => {
        const p = getPlayerBySocket(socket.id);
        if (!p) return;
        if (!clueBoardState[p.id]) clueBoardState[p.id] = {};
        clueBoardState[p.id][data.name] = data.state;
    });

    // ------------------------------------------
    // HOST GOD MODE
    // ------------------------------------------
    socket.on('host_kick_player', (pId) => {
        if (socket.id !== hostSocketId) return;
        delete players[pId];
        io.emit('update_players', Object.values(players));
        broadcastGraveyard();
    });

    socket.on('host_force_next', () => {
        if (socket.id !== hostSocketId) return;
        clearTimeout(phaseTimeoutId);
        clearTimeout(nightTimerTimeout);
        if (gameState === 'DAY') startDayVoting();
        else if (gameState === 'DAY_VOTE') tallyDayVotes();
        else if (gameState === 'INTERROGATION') nextInterrogationTurn();
        else if (gameState === 'NIGHT') {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            (async () => {
                await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                processNextNightTurn();
            })();
        }
    });

    // ------------------------------------------
    // GAME START
    // ------------------------------------------
    socket.on('start_game', async (config) => {
        gameConfig = config;
        const playerIds = Object.keys(players);

        let mPool = [];
        if (config.roles.godfather) mPool.push('Godfather');
        if (config.roles.voodoo) mPool.push('Voodoo Lady');
        if (config.roles.framer) mPool.push('Framer');
        if (config.roles.jammer) mPool.push('Logic Jammer');
        if (config.roles.consigliere) mPool.push('Consigliere');
        mPool = shuffle(mPool);

        let tPool = [];
        if (config.roles.doctor) tPool.push('Doctor');
        if (config.roles.detective) tPool.push('Detective');
        if (config.roles.mayor) tPool.push('Mayor');
        if (config.roles.socialite) tPool.push('Socialite');
        if (config.roles.vigilante) tPool.push('Vigilante');
        if (config.roles.agent) tPool.push('Intelligence Agent');
        tPool = shuffle(tPool);

        let finalRoles = [];
        const reqMafia = config.mafiaCount || 1;
        for (let i = 0; i < reqMafia; i++) finalRoles.push(mPool.pop() || 'Mafia');
        for (let i = 0; i < playerIds.length - reqMafia; i++) finalRoles.push(tPool.pop() || 'Villager');
        finalRoles = shuffle(finalRoles);

        activeWeapons = (config.customWeapons && config.customWeapons.trim()) ? config.customWeapons.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_WEAPONS;
        activeLocations = (config.customLocations && config.customLocations.trim()) ? config.customLocations.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_LOCATIONS;

        resetGameState();
        Object.values(players).forEach(p => { p.isAlive = true; p.role = null; });

        const mafiaIds = [];
        playerIds.forEach((id, index) => {
            players[id].role = finalRoles[index];
            if (isMafiaTeam(players[id].role)) {
                mafiaIds.push(id);
                io.sockets.sockets.get(players[id].socketId)?.join('mafia_room');
            }
            if (players[id].role === 'Vigilante') vigilanteBullets[id] = 1;
        });

        trueMurderer = mafiaIds[Math.floor(Math.random() * mafiaIds.length)];
        trueWeapon = activeWeapons[Math.floor(Math.random() * activeWeapons.length)];
        trueLocation = activeLocations[Math.floor(Math.random() * activeLocations.length)];

        playerIds.forEach(id => {
            const p = players[id];
            io.to(p.socketId).emit('role_assigned', {
                displayRole: getDisplayRole(p),
                coreRole: p.role,
                playerList: Object.values(players),
                weapons: activeWeapons,
                locations: activeLocations
            });
        });

        global.gameTheme = config.theme;
        roundNumber = 1;
        broadcastGraveyard();
        // Clear chat history on all clients at game start
        io.emit('clear_mafia_chat');
        startIntroductionPhase();
    });

    // ------------------------------------------
    // PHASE: INTRODUCTION
    // ------------------------------------------
    async function startIntroductionPhase() {
        gameState = 'INTRO';
        io.emit('phase_change', 'INTRO');
        await narratorBroadcastAndWait('Welcome. Please look at your device now to memorize your secret role.', false);

        const introStory = await getAIStory(global.gameTheme, 'The mystery begins. Briefly establish the setting based on the theme. End by telling everyone to close their eyes. Keep it to 2 or 3 sentences.');
        await narratorBroadcastAndWait(introStory, false);

        phaseEndTime = Date.now() + 20000;
        io.emit('start_intro_timer', 20);

        phaseTimeoutId = setTimeout(async () => {
            // Narrator finishes FIRST, then chat opens and 15s timer starts
            await narratorBroadcastAndWait('Everyone, close your eyes. Mafia, open your eyes.', true);

            phaseEndTime = Date.now() + 15000;
            io.emit('start_intro_timer', 15);

            // Open Mafia intro chat with pre-built team roster
            const mafiaRoster = Object.values(players)
                .filter(p => isMafiaTeam(p.role))
                .map(p => `${p.name} (${getDisplayRole(p)})`)
                .join(', ');
            io.to('mafia_room').emit('open_mafia_intro_chat', { roster: mafiaRoster, time: 15 });

            phaseTimeoutId = setTimeout(async () => {
                io.to('mafia_room').emit('close_mafia_intro_chat');
                await narratorBroadcastAndWait('Mafia, close your eyes. Everyone, open your eyes.', false);
                startInterrogationPhase();
            }, 15000);
        }, 20000);
    }

    // ------------------------------------------
    // PHASE: INTERROGATION
    // ------------------------------------------
    async function startInterrogationPhase() {
        if (roundNumber > gameConfig.maxRounds) return startFinalePhase();
        gameState = 'INTERROGATION';
        io.emit('phase_change', 'INTERROGATION');
        await narratorBroadcastAndWait(`Round ${roundNumber}. The Interrogation Phase begins.`, false);
        interrogationQueue = shuffle(Object.values(players).filter(p => p.isAlive).map(p => p.id));
        nextInterrogationTurn();
    }

    async function nextInterrogationTurn() {
        if (interrogationQueue.length === 0) return startDayPhase();
        currentInterrogatorId = interrogationQueue.shift();
        const activeName = players[currentInterrogatorId].name;
        await narratorBroadcastAndWait(`It is now ${activeName}'s turn to interrogate a suspect.`, false);
        const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
        currentInterrogationState = { activePlayerId: currentInterrogatorId, activePlayerName: activeName, status: 'SELECTING_TARGET', players: aliveList };
        io.emit('interrogation_update', currentInterrogationState);
    }

    socket.on('interrogate_target', (targetId) => {
        const player = getPlayerBySocket(socket.id);
        if (!player || player.id !== currentInterrogatorId || !players[targetId]) return;
        const durationSec = gameConfig.timer;
        phaseEndTime = Date.now() + (durationSec * 1000);
        currentInterrogationState = { activePlayerId: currentInterrogatorId, activePlayerName: player.name, targetName: players[targetId].name, status: 'TICKING', duration: durationSec };
        io.emit('interrogation_update', currentInterrogationState);

        phaseTimeoutId = setTimeout(() => {
            const list = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
            io.to(socket.id).emit('prompt_clue_guess', { weapons: activeWeapons, locations: activeLocations, playerList: list });
            currentInterrogationState.status = 'GUESSING';
            io.emit('interrogation_update', currentInterrogationState);
        }, durationSec * 1000);
    });

    socket.on('submit_clue_guess', async (guess) => {
        const player = getPlayerBySocket(socket.id);
        if (!player || player.id !== currentInterrogatorId) return;
        if (currentInterrogationState.status !== 'GUESSING') return; // double-click lock
        currentInterrogationState.status = 'RESOLVING';

        let actualScore = (guess.murderer === trueMurderer ? 1 : 0) + (guess.weapon === trueWeapon ? 1 : 0) + (guess.location === trueLocation ? 1 : 0);
        let reportedScore = actualScore;

        // Logic Jammer deception
        if (jammedPlayers.has(player.id)) {
            const fakeScores = [0, 1, 2, 3].filter(s => s !== actualScore);
            reportedScore = fakeScores[Math.floor(Math.random() * fakeScores.length)];
            jammedPlayers.delete(player.id);
        }

        const symbol = reportedScore === 3 ? '🟢' : (reportedScore > 0 ? '⚠️' : '❌');
        io.to(player.socketId).emit('toast_msg', {
            text: `Result: ${symbol}`,
            type: reportedScore === 3 ? 'success' : 'warning',
            notepadText: `\n[Guess] ${players[guess.murderer]?.name}, ${guess.location}, ${guess.weapon} -> ${symbol}`,
            guess,
            score: reportedScore,
            symbol
        });

        if (reportedScore === 3) {
            await narratorBroadcastAndWait('Wait! An incredible deduction has been made! Someone correctly guessed all three pieces of the puzzle!', false);
        } else {
            await new Promise(res => setTimeout(res, 2000));
        }
        nextInterrogationTurn();
    });

    // ------------------------------------------
    // PHASE: DAY
    // ------------------------------------------
    async function startDayPhase() {
        gameState = 'DAY';
        readyPlayers.clear();
        io.emit('phase_change', 'DAY');
        await narratorBroadcastAndWait(`Town Hall discussion is now open. You have ${gameConfig.dayTimer} seconds.`, false);
        phaseEndTime = Date.now() + (gameConfig.dayTimer * 1000);
        io.emit('start_day_timer', gameConfig.dayTimer);
        phaseTimeoutId = setTimeout(startDayVoting, gameConfig.dayTimer * 1000);
    }

    async function startDayVoting() {
        gameState = 'DAY_VOTE';
        dayVotes = {};
        io.emit('phase_change', 'DAY_VOTE');
        await narratorBroadcastAndWait('Discussion ends. You have 30 seconds to lock in an execution vote.', false);
        const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
        Object.values(players).filter(p => p.isAlive).forEach(p => io.to(p.socketId).emit('prompt_day_vote', aliveList));
        phaseEndTime = Date.now() + 30000;
        io.emit('start_day_vote_timer', 30);
        phaseTimeoutId = setTimeout(tallyDayVotes, 30000);
    }

    socket.on('submit_day_vote', (targetId) => {
        const player = getPlayerBySocket(socket.id);
        if (gameState !== 'DAY_VOTE' || !player || !player.isAlive) return;
        dayVotes[player.id] = targetId;
        if (Object.keys(dayVotes).length === Object.values(players).filter(p => p.isAlive).length) {
            clearTimeout(phaseTimeoutId);
            tallyDayVotes();
        }
    });

    async function tallyDayVotes() {
        if (gameState !== 'DAY_VOTE') return; // duplicate-tally lock
        gameState = 'TALLYING';

        let counts = {};

        // Voodoo Lady curse — if cursed player skipped, everyone's vote is suppressed (no execution)
        if (activeVoodooCurse && players[activeVoodooCurse] && players[activeVoodooCurse].isAlive) {
            const cursedVote = dayVotes[activeVoodooCurse];
            if (!cursedVote || cursedVote === 'SKIP') {
                await narratorBroadcastAndWait('A dark curse takes hold... but the cursed soul stays silent. No execution today.', false);
                activeVoodooCurse = null;
                broadcastGraveyard();
                return startNightPhase();
            }
            counts[cursedVote] = 999;
            await narratorBroadcastAndWait('A dark curse takes hold! All voices are silenced except one...', false);
        } else {
            Object.entries(dayVotes).forEach(([pId, target]) => {
                if (target && target !== 'SKIP') counts[target] = (counts[target] || 0) + (players[pId].role === 'Mayor' ? 2 : 1);
            });
        }
        activeVoodooCurse = null;

        let max = 0, accId = null, tie = false;
        for (const [id, c] of Object.entries(counts)) {
            if (c > max) { max = c; accId = id; tie = false; } else if (c === max) tie = true;
        }

        if (tie || !accId) {
            await narratorBroadcastAndWait('The town is deadlocked. No execution takes place.', false);
            logEvent('no_execution', `Round ${roundNumber}: Town was deadlocked. No one was executed.`);
        } else {
            players[accId].isAlive = false;
            let roleReveal = players[accId].role;
            if (roleReveal === 'Mafia') roleReveal = (accId === trueMurderer) ? 'Mafia Murderer' : 'Mafia Accomplice';

            if (gameConfig.blindExecutions) {
                await narratorBroadcastAndWait(`${players[accId].name} was executed by the town. Their true role remains a mystery.`, false);
            } else {
                await narratorBroadcastAndWait(`${players[accId].name} was executed by the town. They were a ${roleReveal}.`, false);
            }
            logEvent('execution', `Round ${roundNumber}: ${players[accId].name} was executed by the town. (${roleReveal})`);

            if (isMafiaTeam(players[accId].role)) {
                const cluesToGive = parseInt(gameConfig.cluesPerExecution) || 0;
                if (cluesToGive > 0) await narratorBroadcastAndWait('A search of their belongings revealed secrets...', false);
                for (let i = 0; i < cluesToGive; i++) await narratorBroadcastAndWait(generateUniqueMafiaClue(), false);
            }
        }
        broadcastGraveyard();
        startNightPhase();
    }

    // ------------------------------------------
    // PHASE: NIGHT
    // ------------------------------------------
    async function startNightPhase() {
        gameState = 'NIGHT';
        jammedPlayers.clear();
        nightActions = {
            mafiaVotes: {},
            lockedMafiaTarget: null,
            doctorTarget: null,
            detectiveTarget: null,
            detectiveSocketId: null,
            detectivePlayerId: null,
            framerTarget: null,
            voodooTarget: null,
            socialiteTarget: null,
            vigilanteTarget: null,
            jammerTarget: null,
            submissions: new Set()
        };
        io.emit('phase_change', 'NIGHT');
        await narratorBroadcastAndWait('Night falls. Everyone, close your eyes.', true);

        nightSequence = [];
        if (roleInGame('Socialite')) nightSequence.push('Socialite');
        nightSequence.push('Mafia');
        if (roleInGame('Logic Jammer')) nightSequence.push('Logic Jammer');
        if (roleInGame('Consigliere')) nightSequence.push('Consigliere');
        if (roleInGame('Intelligence Agent')) nightSequence.push('Intelligence Agent');
        if (roleInGame('Framer')) nightSequence.push('Framer');
        if (roleInGame('Voodoo Lady')) nightSequence.push('Voodoo Lady');
        if (roleInGame('Doctor')) nightSequence.push('Doctor');
        if (roleInGame('Detective')) nightSequence.push('Detective');
        const vigPlayer = Object.values(players).find(p => p.role === 'Vigilante');
        if (vigPlayer && vigilanteBullets[vigPlayer.id] > 0) nightSequence.push('Vigilante');

        processNextNightTurn();
    }

    async function processNextNightTurn() {
        if (currentNightRole) io.emit('close_night_action');
        if (nightSequence.length === 0) return resolveNight();

        currentNightRole = nightSequence.shift();
        const rolePlayers = Object.values(players).filter(p => currentNightRole === 'Mafia' ? isMafiaTeam(p.role) : p.role === currentNightRole);
        const livingRolePlayers = rolePlayers.filter(p => p.isAlive);

        nightActions.submissions = new Set();
        expectedNightSubmissions = livingRolePlayers.length;
        currentNightSubmissions = 0;
        nightTurnActive = true;

        const time = expectedNightSubmissions > 0 ? 30 : Math.floor(Math.random() * 6) + 5;
        const msg = currentNightRole === 'Mafia' ? 'Mafia, open your eyes and select a victim.' : `${currentNightRole}, open your eyes.`;
        await narratorBroadcastAndWait(msg, true);

        nightTimerEndTime = Date.now() + (time * 1000);

        // Build valid targets per role, with appropriate filters
        let validTargets = Object.values(players).filter(p => p.isAlive);
        if (currentNightRole === 'Socialite') validTargets = validTargets.filter(p => !livingRolePlayers.some(lp => lp.id === p.id)); // no self-distract
        if (currentNightRole === 'Mafia') validTargets = validTargets.filter(p => !isMafiaTeam(p.role)); // no self-kill
        if (currentNightRole === 'Voodoo Lady') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));

        livingRolePlayers.forEach(p => {
            io.to(p.socketId).emit('night_action_phase', {
                role: currentNightRole,
                time,
                players: validTargets.map(v => ({ id: v.id, name: v.name })),
                weapons: activeWeapons,
                locations: activeLocations
            });
        });

        nightTimerTimeout = setTimeout(async () => {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
            await new Promise(res => setTimeout(res, 1000));
            processNextNightTurn();
        }, time * 1000);
    }

    socket.on('submit_night_action', (data) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !p.isAlive) return;
        if (nightActions.submissions.has(p.id)) return; // no double submissions
        nightActions.submissions.add(p.id);

        if (data.role === 'Socialite' && p.role === 'Socialite' && data.targetId !== 'SKIP') nightActions.socialiteTarget = data.targetId;
        if (data.role === 'Logic Jammer' && p.role === 'Logic Jammer' && data.targetId !== 'SKIP') nightActions.jammerTarget = data.targetId;
        if (data.role === 'Framer' && p.role === 'Framer' && data.targetId !== 'SKIP') nightActions.framerTarget = data.targetId;
        if (data.role === 'Voodoo Lady' && p.role === 'Voodoo Lady' && data.targetId !== 'SKIP') nightActions.voodooTarget = data.targetId;

        // Doctor: validate target is still alive (stale UI on reconnect could send a dead ID)
        if (data.role === 'Doctor' && p.role === 'Doctor' && data.targetId !== 'SKIP') {
            if (players[data.targetId] && players[data.targetId].isAlive) {
                nightActions.doctorTarget = data.targetId;
            }
        }

        // Intel roles: clarify weapon vs location in notepad
        if ((data.role === 'Consigliere' || data.role === 'Intelligence Agent') && p.role === data.role && data.targetItem !== 'SKIP') {
            const isCorrect = (data.targetItem === trueWeapon || data.targetItem === trueLocation);
            const itemCategory = activeWeapons.includes(data.targetItem) ? 'Weapon' : 'Location';
            io.to(socket.id).emit('toast_msg', {
                text: isCorrect ? '✅ Intel: TRUE' : '❌ Intel: FALSE',
                type: isCorrect ? 'success' : 'error',
                notepadText: `\n[NIGHT] ${itemCategory} "${data.targetItem}" is ${isCorrect ? 'part of the crime' : 'not involved'}.`
            });
        }

        // Detective: store for deferred result in resolveNight (after Framer/Socialite blocks resolve)
        if (data.role === 'Detective' && p.role === 'Detective' && data.targetId !== 'SKIP') {
            nightActions.detectiveTarget = data.targetId;
            nightActions.detectiveSocketId = socket.id;
            nightActions.detectivePlayerId = p.id;
        }

        if (data.role === 'Vigilante' && p.role === 'Vigilante') {
            if (data.targetId !== 'SKIP') nightActions.vigilanteTarget = data.targetId;
            vigilanteBullets[p.id] = 0;
        }

        currentNightSubmissions = nightActions.submissions.size;
        if (currentNightSubmissions >= expectedNightSubmissions && expectedNightSubmissions > 0) {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            clearTimeout(nightTimerTimeout);
            (async () => {
                await new Promise(res => setTimeout(res, 4000)); // pause to read results
                await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                await new Promise(res => setTimeout(res, 1000));
                processNextNightTurn();
            })();
        }
    });

    socket.on('mafia_vote', (targetId) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !isMafiaTeam(p.role) || !p.isAlive) return;
        // Server-side guard: mafia cannot vote for themselves or other mafia members
        if (!players[targetId] || isMafiaTeam(players[targetId].role)) return;

        nightActions.mafiaVotes[p.id] = targetId;
        if (Object.keys(nightActions.mafiaVotes).length === expectedNightSubmissions) {
            const targets = [...new Set(Object.values(nightActions.mafiaVotes))];
            if (targets.length === 1) {
                if (!nightTurnActive) return;
                nightTurnActive = false;
                nightActions.lockedMafiaTarget = targets[0];
                clearTimeout(nightTimerTimeout);
                (async () => {
                    await new Promise(res => setTimeout(res, 4000));
                    await narratorBroadcastAndWait('Mafia, close your eyes.', true);
                    await new Promise(res => setTimeout(res, 1000));
                    processNextNightTurn();
                })();
            }
        }
    });

    async function resolveNight() {
        currentNightRole = null;
        gameState = 'DAY';
        io.emit('phase_change', 'DAY');

        if (nightActions.jammerTarget) jammedPlayers.add(nightActions.jammerTarget);

        // Apply Socialite block — cancel the blocked player's action
        const blockedId = nightActions.socialiteTarget;
        if (blockedId && players[blockedId]) {
            // Any blocked mafia member cancels the kill (kill is a team consensus)
            if (isMafiaTeam(players[blockedId].role)) nightActions.lockedMafiaTarget = null;
            if (players[blockedId].role === 'Doctor') nightActions.doctorTarget = null;
            if (players[blockedId].role === 'Framer') nightActions.framerTarget = null;
            // jammedPlayers stores TARGET IDs — delete the jammer's target, not the jammer
            if (players[blockedId].role === 'Logic Jammer') jammedPlayers.delete(nightActions.jammerTarget);
            if (players[blockedId].role === 'Voodoo Lady') nightActions.voodooTarget = null;
            if (players[blockedId].role === 'Vigilante') nightActions.vigilanteTarget = null;
            io.to(players[blockedId].socketId).emit('toast_msg', {
                text: '🍸 Distracted!',
                type: 'warning',
                notepadText: '\n[NIGHT] You were distracted by the Socialite! Your night action failed.'
            });
            logEvent('distracted', `Round ${roundNumber}: ${players[blockedId].name} (${players[blockedId].role}) was distracted by the Socialite.`);
        }

        // Send Detective result NOW — after Framer/Socialite blocks are fully resolved
        if (nightActions.detectiveTarget && nightActions.detectiveSocketId) {
            const detTarget = nightActions.detectiveTarget;
            if (nightActions.socialiteTarget !== nightActions.detectivePlayerId) {
                let isEvil = isMafiaTeam(players[detTarget].role);
                if (players[detTarget].role === 'Godfather') isEvil = false;
                if (nightActions.framerTarget === detTarget) isEvil = true; // framerTarget already null if framer was blocked
                io.to(nightActions.detectiveSocketId).emit('toast_msg', {
                    text: `Scan: ${players[detTarget].name} is ${isEvil ? 'Mafia' : 'Innocent'}!`,
                    type: isEvil ? 'error' : 'success',
                    notepadText: `\n[NIGHT] ${players[detTarget].name} scanned as ${isEvil ? 'Mafia' : 'Innocent'}.`
                });
            }
        }

        activeVoodooCurse = nightActions.voodooTarget;
        const mTarget = nightActions.lockedMafiaTarget;
        const vigTarget = nightActions.vigilanteTarget;

        const diedTonight = [];

        if (mTarget && mTarget !== nightActions.doctorTarget) {
            diedTonight.push(mTarget);
        } else if (mTarget && mTarget === nightActions.doctorTarget) {
            logEvent('saved', `Round ${roundNumber}: ${players[mTarget].name} was targeted by Mafia but saved by the Doctor.`);
        }

        if (vigTarget && vigTarget !== nightActions.doctorTarget) {
            if (!diedTonight.includes(vigTarget)) diedTonight.push(vigTarget);
            logEvent('vigilante_kill', `Round ${roundNumber}: ${players[vigTarget].name} was shot by the Vigilante.`);
        } else if (vigTarget && vigTarget === nightActions.doctorTarget) {
            logEvent('saved', `Round ${roundNumber}: ${players[vigTarget].name} was shot by the Vigilante but saved by the Doctor.`);
        }

        await narratorBroadcastAndWait('Morning comes. Everyone, open your eyes.', false);
        const story = await getAIStory(global.gameTheme, diedTonight.length === 0
            ? 'The night was unusually still and quiet. No one was harmed.'
            : `The group wakes to find ${diedTonight.map(id => players[id].name).join(' and ')} eliminated.`);
        await narratorBroadcastAndWait(story, false);

        diedTonight.forEach(id => {
            players[id].isAlive = false;
            logEvent('night_kill', `Round ${roundNumber}: ${players[id].name} (${players[id].role}) was eliminated during the night.`);
        });

        broadcastGraveyard();
        roundNumber++;
        startInterrogationPhase();
    }

    // ------------------------------------------
    // PHASE: FINALE
    // ------------------------------------------
    async function startFinalePhase() {
        gameState = 'FINALE';
        finaleGuesses = {};
        io.emit('phase_change', 'FINALE');
        await narratorBroadcastAndWait('The time of final judgment is here. Submit your accusations.', false);
        Object.values(players).filter(p => p.isAlive).forEach(p => {
            io.to(p.socketId).emit('prompt_finale_guess', { weapons: activeWeapons, locations: activeLocations, playerList: Object.values(players) });
        });
    }

    socket.on('submit_finale_guess', async (guess) => {
        const p = getPlayerBySocket(socket.id);
        if (gameState !== 'FINALE' || !p?.isAlive) return;
        finaleGuesses[p.id] = guess;

        if (Object.keys(finaleGuesses).length === Object.values(players).filter(pl => pl.isAlive).length) {
            gameState = 'GAME_OVER';
            io.emit('phase_change', 'GAME_OVER');

            let vWon = false;
            for (const [pId, g] of Object.entries(finaleGuesses)) {
                if (!isMafiaTeam(players[pId].role) && g.murderer === trueMurderer && g.weapon === trueWeapon && g.location === trueLocation) vWon = true;
            }
            const truth = `${players[trueMurderer].name} in the ${trueLocation} with the ${trueWeapon}`;
            await narratorBroadcastAndWait(vWon ? `🟢 VILLAGERS WIN! Truth: ${truth}` : `❌ MAFIA WINS! Truth: ${truth}`, false);

            // Broadcast full post-game recap
            io.emit('game_recap', {
                winner: vWon ? 'TOWN' : 'MAFIA',
                truth: { murdererName: players[trueMurderer].name, weapon: trueWeapon, location: trueLocation },
                log: gameLog,
                roles: Object.values(players).map(pl => ({ name: pl.name, role: getDisplayRole(pl), isAlive: pl.isAlive }))
            });
        }
    });

    // ------------------------------------------
    // RESET
    // ------------------------------------------
    socket.on('reset_game', () => {
        if (socket.id !== hostSocketId) return;
        resetGameState();
        gameState = 'LOBBY';
        Object.values(players).forEach(p => { p.isAlive = true; p.role = null; });
        // Close intro chat in case reset fires during Mafia's 15s window
        io.to('mafia_room').emit('close_mafia_intro_chat');
        io.emit('clear_mafia_chat');
        io.emit('phase_change', 'LOBBY');
        io.emit('update_players', Object.values(players));
    });

    socket.on('disconnect', () => {
        if (socket.id === hostSocketId) hostSocketId = null;
        const p = getPlayerBySocket(socket.id);
        if (p && (gameState === 'LOGIN' || gameState === 'LOBBY')) {
            delete players[p.id];
            io.emit('update_players', Object.values(players));
        }
    });
});

server.listen(3000, () => console.log('Mafia x Clue server running...'));
