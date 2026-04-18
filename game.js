/**
 * Pipe — Modern Pipe Mania
 * Place pipes to guide water from the source.
 * Reach the minimum pipe count to clear each level.
 */
(function () {
    'use strict';

    /* ── Direction constants ── */
    const T = 0, R = 1, B = 2, L = 3;
    const OPP = [2, 3, 0, 1];
    const DX = [0, 1, 0, -1];
    const DY = [-1, 0, 1, 0];

    /* ── Pipe definitions ── */
    const PIPE_CONN = {
        H:  [0,1,0,1],
        V:  [1,0,1,0],
        TL: [1,0,0,1],
        TR: [1,1,0,0],
        BL: [0,0,1,1],
        BR: [0,1,1,0],
        X:  [1,1,1,1],
    };
    const POOL = ['H','H','H','V','V','V','TL','TL','TR','TR','BL','BL','BR','BR','X'];

    /* ── Config ── */
    const CFG = {
        gridSize: 7,
        queueLen: 5,
        prepTime: 25,
        flowMs: 1100,
        minPipes: 8,
        pipeScore: 100,
        crossBonus: 200,
        levelBonus: 500,
        replacePen: 50,
        sound: true,
    };

    /* ── State ── */
    let grid, source, queue, score, highScore, level;
    let gamePhase; // prep | flow | over | complete
    let prepLeft, prepInterval;
    let flowPath, flowIdx, flowProg, flowAF, lastFlowT;
    let hoverC = -1, hoverR = -1;
    let cvs, ctx, cs, bgCvs, bgCtx;
    let audioCtx, levelScoreStart;

    /* ── DOM refs ── */
    const $ = id => document.getElementById(id);
    const scoreEl = $('score-display'), levelEl = $('level-display'), hiEl = $('highscore-display'), targetEl = $('target-display');
    const infoBar = $('info-bar'), infoText = $('info-text'), cdFill = $('countdown-fill');
    const queueList = $('queue-list');
    const overlayGO = $('overlay-gameover'), overlayLV = $('overlay-level'), overlayST = $('overlay-settings');

    /* ── Audio ── */
    function initAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    function beep(freq, dur, type, vol) {
        if (!CFG.sound || !audioCtx) return;
        try {
            const t = audioCtx.currentTime;
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.connect(g); g.connect(audioCtx.destination);
            o.type = type || 'sine';
            o.frequency.setValueAtTime(freq, t);
            g.gain.setValueAtTime(vol || 0.08, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            o.start(t); o.stop(t + dur);
        } catch (_) {}
    }

    function sfx(name) {
        if (!CFG.sound || !audioCtx) return;
        switch (name) {
            case 'place':   beep(600, 0.08); break;
            case 'replace': beep(300, 0.12, 'triangle'); break;
            case 'flow':    beep(800, 0.06, 'sine', 0.05); break;
            case 'end':     beep(250, 0.5, 'triangle'); break;
            case 'win':     [523,659,784,1047].forEach((f, i) => setTimeout(() => beep(f, 0.2), i * 90)); break;
        }
    }

    /* ── Helpers ── */
    function randPipe() { return POOL[Math.floor(Math.random() * POOL.length)]; }

    function getExit(type, entry) {
        const c = PIPE_CONN[type];
        if (!c[entry]) return -1;
        if (type === 'X') return OPP[entry];
        for (let d = 0; d < 4; d++) if (d !== entry && c[d]) return d;
        return -1;
    }

    function prepDuration() { return Math.max(CFG.prepTime - (level - 1) * 2, 10); }
    function neededPipes() { return CFG.minPipes + (level - 1) * 2; }
    function flowSpeed() { return Math.max(CFG.flowMs - (level - 1) * 80, 300); }

    /* ── Grid ── */
    function makeGrid() {
        grid = Array.from({ length: CFG.gridSize }, () => Array(CFG.gridSize).fill(null));
    }

    function placeSource() {
        const gs = CFG.gridSize;
        const edge = Math.floor(Math.random() * 4);
        let col, row, dir;
        switch (edge) {
            case 0: col = 1 + Math.floor(Math.random() * (gs - 2)); row = 0;      dir = B; break;
            case 1: col = gs - 1; row = 1 + Math.floor(Math.random() * (gs - 2)); dir = L; break;
            case 2: col = 1 + Math.floor(Math.random() * (gs - 2)); row = gs - 1; dir = T; break;
            default: col = 0;    row = 1 + Math.floor(Math.random() * (gs - 2)); dir = R; break;
        }
        source = { col, row, dir };
    }

    /* ── Queue ── */
    function fillQueue() {
        queue = [];
        for (let i = 0; i < CFG.queueLen; i++) queue.push(randPipe());
    }

    function shiftQueue() {
        const p = queue.shift();
        queue.push(randPipe());
        return p;
    }

    function renderQueue() {
        while (queueList.children.length > CFG.queueLen) queueList.removeChild(queueList.lastChild);
        while (queueList.children.length < CFG.queueLen) {
            const slot = document.createElement('div');
            slot.className = 'queue-slot';
            const c = document.createElement('canvas');
            const dpr = devicePixelRatio || 1;
            c.width = 44 * dpr; c.height = 44 * dpr;
            c.style.width = '44px'; c.style.height = '44px';
            slot.appendChild(c);
            queueList.appendChild(slot);
        }
        const slots = queueList.querySelectorAll('.queue-slot');
        queue.forEach((type, i) => {
            drawPipeMini(slots[i].querySelector('canvas'), type);
        });
    }

    function drawPipeMini(canvas, type) {
        const c = canvas.getContext('2d');
        const dpr = devicePixelRatio || 1;
        const s = canvas.width / dpr;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, s, s);
        const cx = s / 2, cy = s / 2;
        const conn = PIPE_CONN[type];
        
        c.lineCap = 'butt';
        c.lineJoin = 'round';
        c.strokeStyle = '#1e212b';
        c.lineWidth = s * 0.45;
        drawPipePaths(c, cx, cy, s, conn);
        
        c.strokeStyle = '#2b2f3e';
        c.lineWidth = s * 0.25;
        drawPipePaths(c, cx, cy, s, conn);
    }

    /* ── Canvas sizing ── */
    function resize() {
        const area = $('game-area');
        const qw = ($('queue-panel')?.offsetWidth || 60) + 24;
        const aw = area.clientWidth - qw - 48;
        const ah = area.clientHeight - 32;
        cs = Math.max(Math.min(Math.floor(aw / CFG.gridSize), Math.floor(ah / CFG.gridSize), 72), 32);
        const w = CFG.gridSize * cs, h = CFG.gridSize * cs;
        const dpr = devicePixelRatio || 1;
        
        cvs.width = w * dpr; cvs.height = h * dpr;
        cvs.style.width = w + 'px'; cvs.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (!bgCvs) {
            bgCvs = document.createElement('canvas');
            bgCtx = bgCvs.getContext('2d');
        }
        bgCvs.width = w * dpr; bgCvs.height = h * dpr;
        bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Pre-render background
        bgCtx.fillStyle = '#0b0c10';
        bgCtx.fillRect(0, 0, w, h);
        bgCtx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let c = 1; c < CFG.gridSize; c++) {
            for (let r = 1; r < CFG.gridSize; r++) {
                bgCtx.beginPath(); bgCtx.arc(c * cs, r * cs, 1.5, 0, Math.PI * 2); bgCtx.fill();
            }
        }
        bgCtx.strokeStyle = 'rgba(255,255,255,0.02)';
        bgCtx.lineWidth = 1;
        for (let i = 1; i < CFG.gridSize; i++) {
            bgCtx.beginPath(); bgCtx.moveTo(i * cs, 0); bgCtx.lineTo(i * cs, h); bgCtx.stroke();
            bgCtx.beginPath(); bgCtx.moveTo(0, i * cs); bgCtx.lineTo(w, i * cs); bgCtx.stroke();
        }

        draw();
    }

    /* ── Drawing core ── */
    function drawPipePaths(c, cx, cy, size, conn) {
        c.beginPath();
        const r = size / 2;
        
        if (conn[T] && conn[B] && !conn[L] && !conn[R]) {
            c.moveTo(cx, cy - r); c.lineTo(cx, cy + r);
        } else if (conn[L] && conn[R] && !conn[T] && !conn[B]) {
            c.moveTo(cx - r, cy); c.lineTo(cx + r, cy);
        } else if (conn[T] && conn[R] && !conn[B] && !conn[L]) {
            c.moveTo(cx, cy - r); c.quadraticCurveTo(cx, cy, cx + r, cy);
        } else if (conn[R] && conn[B] && !conn[T] && !conn[L]) {
            c.moveTo(cx + r, cy); c.quadraticCurveTo(cx, cy, cx, cy + r);
        } else if (conn[B] && conn[L] && !conn[T] && !conn[R]) {
            c.moveTo(cx, cy + r); c.quadraticCurveTo(cx, cy, cx - r, cy);
        } else if (conn[L] && conn[T] && !conn[B] && !conn[R]) {
            c.moveTo(cx - r, cy); c.quadraticCurveTo(cx, cy, cx, cy - r);
        } else if (conn[T] && conn[B] && conn[L] && conn[R]) {
            c.moveTo(cx, cy - r); c.lineTo(cx, cy + r);
            c.moveTo(cx - r, cy); c.lineTo(cx + r, cy);
        }
        c.stroke();
    }

    /* ── Main draw ── */
    function draw() {
        const gs = CFG.gridSize, w = gs * cs, h = gs * cs;

        // Draw cached background
        ctx.clearRect(0, 0, w, h);
        if (bgCvs) {
            ctx.drawImage(bgCvs, 0, 0, w, h);
        }

        // Pipes
        for (let c = 0; c < gs; c++) for (let r = 0; r < gs; r++) {
            const cell = grid[c][r];
            if (!cell || (c === source.col && r === source.row)) continue;
            drawPipeCell(c, r, cell.type, cell.water);
        }

        // Source
        drawSource();

        // Water animation on current flowing segment
        if (gamePhase === 'flow' && flowIdx < flowPath.length) {
            const seg = flowPath[flowIdx];
            drawWaterPartial(seg.col, seg.row, seg.entry, seg.exit, flowProg);
        }

        // Hover preview
        if (hoverC >= 0 && hoverR >= 0 && hoverC < gs && hoverR < gs
            && gamePhase !== 'over' && gamePhase !== 'complete'
            && (hoverC !== source.col || hoverR !== source.row)) {
            const x = hoverC * cs, y = hoverR * cs;
            ctx.fillStyle = 'rgba(0,229,160,0.08)';
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 4, y + 4, cs - 8, cs - 8, 8); ctx.fill();
            } else {
                ctx.fillRect(x + 4, y + 4, cs - 8, cs - 8);
            }
            if (queue.length) {
                ctx.globalAlpha = 0.5;
                const cxh = x + cs / 2, cyh = y + cs / 2;
                ctx.lineCap = 'butt';
                ctx.lineJoin = 'round';
                ctx.strokeStyle = '#2b2f3e';
                ctx.lineWidth = cs * 0.25;
                drawPipePaths(ctx, cxh, cyh, cs, PIPE_CONN[queue[0]]);
                ctx.globalAlpha = 1;
            }
        }
    }

    function drawSource() {
        const x = source.col * cs, y = source.row * cs;
        const cx = x + cs / 2, cy = y + cs / 2, r = cs / 2;

        ctx.save();
        ctx.shadowColor = '#e74c3c';
        ctx.shadowBlur = 20;
        ctx.fillStyle = 'rgba(231,76,60,0.15)';
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#3a1a1a';
        ctx.lineWidth = cs * 0.45;
        
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        if (source.dir === T) ctx.lineTo(cx, cy - r);
        if (source.dir === R) ctx.lineTo(cx + r, cy);
        if (source.dir === B) ctx.lineTo(cx, cy + r);
        if (source.dir === L) ctx.lineTo(cx - r, cy);
        ctx.stroke();

        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = cs * 0.25;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = '#1e1010';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.12, 0, Math.PI * 2);
        ctx.fillStyle = '#e74c3c';
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = `bold ${cs * 0.25}px Outfit`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const arrows = ['▲', '▶', '▼', '◀'];
        const off = cs * 0.12;
        const ox = [0, off, 0, -off], oy = [-off, 0, off, 0];
        ctx.fillText(arrows[source.dir], cx + ox[source.dir], cy + oy[source.dir]);
    }

    function drawPipeCell(col, row, type, water) {
        const x = col * cs, y = row * cs;
        const cx = x + cs / 2, cy = y + cs / 2;
        const conn = PIPE_CONN[type];

        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        
        ctx.strokeStyle = '#1e212b';
        ctx.lineWidth = cs * 0.45;
        drawPipePaths(ctx, cx, cy, cs, conn);

        ctx.strokeStyle = '#2b2f3e';
        ctx.lineWidth = cs * 0.25;
        drawPipePaths(ctx, cx, cy, cs, conn);

        if (water) {
            ctx.save();
            ctx.shadowColor = '#00e5a0';
            ctx.shadowBlur = 12;
            ctx.strokeStyle = '#00e5a0';
            ctx.lineWidth = cs * 0.15;
            drawPipePaths(ctx, cx, cy, cs, conn);
            ctx.restore();
        }
    }

    function drawWaterPartial(col, row, entry, exit, prog) {
        const cx = col * cs + cs / 2, cy = row * cs + cs / 2, r = cs / 2;

        ctx.save();
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.shadowColor = '#00e5a0';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#00e5a0';
        ctx.lineWidth = cs * 0.15;

        ctx.beginPath();
        let startX = cx, startY = cy;
        if (entry === T) startY -= r;
        if (entry === B) startY += r;
        if (entry === L) startX -= r;
        if (entry === R) startX += r;

        let endX = cx, endY = cy;
        if (exit === T) endY -= r;
        if (exit === B) endY += r;
        if (exit === L) endX -= r;
        if (exit === R) endX += r;
        
        const isStraight = (entry === T && exit === B) || (entry === B && exit === T) || (entry === L && exit === R) || (entry === R && exit === L);
        
        ctx.moveTo(startX, startY);
        if (isStraight) {
            ctx.lineTo(startX + (endX - startX) * prog, startY + (endY - startY) * prog);
        } else {
            const steps = Math.ceil(prog * 20);
            for (let i = 1; i <= steps; i++) {
                const t = (i / 20);
                if (t > prog) break;
                ctx.lineTo(Math.pow(1-t, 2) * startX + 2*(1-t)*t * cx + Math.pow(t, 2) * endX, 
                           Math.pow(1-t, 2) * startY + 2*(1-t)*t * cy + Math.pow(t, 2) * endY);
            }
            const t = prog;
            ctx.lineTo(Math.pow(1-t, 2) * startX + 2*(1-t)*t * cx + Math.pow(t, 2) * endX, 
                       Math.pow(1-t, 2) * startY + 2*(1-t)*t * cy + Math.pow(t, 2) * endY);
        }
        
        ctx.stroke();
        ctx.restore();
    }

    /* ── Placement ── */
    function placePipe(col, row) {
        if (gamePhase === 'over' || gamePhase === 'complete') return;
        if (col === source.col && row === source.row) return;
        initAudio();

        const existing = grid[col][row];
        if (existing?.water) return;

        if (existing) {
            score = Math.max(0, score - CFG.replacePen);
            sfx('replace');
        } else {
            sfx('place');
        }

        grid[col][row] = { type: shiftQueue(), water: false };
        renderQueue();
        updateUI();
        draw();
    }

    /* ── Flow ── */
    function startFlow() {
        gamePhase = 'flow';
        clearInterval(prepInterval);
        cdFill.style.width = '0%';
        setInfo('Water is flowing...', 'highlight');
        flowPath = [];
        flowIdx = 0;
        flowProg = 0;
        advanceFlow();
    }

    function advanceFlow() {
        let nextCol, nextRow, entryDir;

        if (flowPath.length === 0) {
            nextCol  = source.col + DX[source.dir];
            nextRow  = source.row + DY[source.dir];
            entryDir = OPP[source.dir];
        } else {
            const last = flowPath[flowPath.length - 1];
            nextCol  = last.col + DX[last.exit];
            nextRow  = last.row + DY[last.exit];
            entryDir = OPP[last.exit];
        }

        // Bounds check
        if (nextCol < 0 || nextCol >= CFG.gridSize || nextRow < 0 || nextRow >= CFG.gridSize) return endFlow();
        if (nextCol === source.col && nextRow === source.row) return endFlow();

        const cell = grid[nextCol][nextRow];
        if (!cell) return endFlow();

        const exitDir = getExit(cell.type, entryDir);
        if (exitDir === -1) return endFlow();

        // Cross pipe channel check
        if (cell.type === 'X' && cell.water) {
            const channel = (entryDir === L || entryDir === R) ? 'h' : 'v';
            if (cell.waterChannel === channel) return endFlow();
        }

        flowPath.push({ col: nextCol, row: nextRow, entry: entryDir, exit: exitDir });
        flowIdx = flowPath.length - 1;
        flowProg = 0;
        lastFlowT = performance.now();
        sfx('flow');
        animateFlow();
    }

    function animateFlow() {
        if (gamePhase !== 'flow') return;

        flowProg = Math.min((performance.now() - lastFlowT) / flowSpeed(), 1);
        draw();

        if (flowProg >= 1) {
            const seg = flowPath[flowIdx];
            const cell = grid[seg.col][seg.row];
            cell.water = true;
            if (cell.type === 'X') cell.waterChannel = (seg.entry === L || seg.entry === R) ? 'h' : 'v';

            const pts = cell.type === 'X' ? CFG.crossBonus : CFG.pipeScore;
            score += pts;
            updateUI();
            floatScore(seg.col, seg.row, pts);
            advanceFlow();
            return;
        }

        flowAF = requestAnimationFrame(animateFlow);
    }

    function endFlow() {
        cancelAnimationFrame(flowAF);
        const passed = flowPath.length;
        const needed = neededPipes();

        if (passed >= needed) {
            score += CFG.levelBonus;
            gamePhase = 'complete';
            sfx('win');
            updateUI();
            setTimeout(() => {
                $('level-pipes').textContent = passed;
                $('level-score-gain').textContent = score - levelScoreStart;
                $('level-message').textContent = `Needed ${needed} pipes, passed through ${passed} pipes!`;
                overlayLV.classList.remove('hidden');
            }, 300);
        } else {
            gamePhase = 'over';
            sfx('end');
            if (score > highScore) { highScore = score; localStorage.setItem('pipe_hi', highScore); }
            updateUI();
            setTimeout(() => {
                $('final-score').textContent = score;
                $('final-level').textContent = level;
                $('final-pipes').textContent = passed;
                $('final-message').textContent = `Needed ${needed} pipes, only passed through ${passed} pipes.`;
                overlayGO.classList.remove('hidden');
            }, 300);
        }
    }

    /* ── Prep countdown ── */
    function startPrep() {
        prepLeft = prepDuration();
        updateCountdown();
        setInfo(`Place pipes — ${prepLeft}s`);

        prepInterval = setInterval(() => {
            prepLeft--;
            if (prepLeft <= 0) {
                startFlow();
            } else {
                updateCountdown();
                setInfo(`Place pipes — ${prepLeft}s`, prepLeft <= 5 ? 'danger' : '');
            }
        }, 1000);
    }

    function updateCountdown() {
        const pct = prepLeft / prepDuration() * 100;
        cdFill.style.width = pct + '%';
        cdFill.style.background = prepLeft <= 5 ? 'rgba(231,76,60,0.15)' : 'var(--accent-dim)';
    }

    /* ── UI ── */
    function setInfo(text, cls) {
        infoText.textContent = text;
        infoBar.classList.remove('highlight', 'danger');
        if (cls) infoBar.classList.add(cls);
    }

    function updateUI() {
        scoreEl.textContent = score;
        levelEl.textContent = level;
        hiEl.textContent = highScore;
        if (targetEl) targetEl.textContent = neededPipes();
        scoreEl.classList.remove('pop');
        void scoreEl.offsetWidth;
        scoreEl.classList.add('pop');
    }

    function floatScore(col, row, pts) {
        const rect = cvs.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'float-score';
        el.textContent = '+' + pts;
        el.style.cssText = `left:${rect.left + col * cs + cs / 2}px;top:${rect.top + row * cs}px;transform:translateX(-50%)`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 800);
    }

    /* ── Game lifecycle ── */
    function resetLevel() {
        cancelAnimationFrame(flowAF);
        clearInterval(prepInterval);
        gamePhase = 'prep';
        hoverC = -1; hoverR = -1;
        makeGrid();
        placeSource();
        fillQueue();
        renderQueue();
        updateUI();
        resize();
        startPrep();
    }

    function newGame() {
        score = 0; level = 1; levelScoreStart = 0;
        overlayGO.classList.add('hidden');
        overlayLV.classList.add('hidden');
        overlayST.classList.add('hidden');
        resetLevel();
    }

    function nextLevel() {
        level++;
        levelScoreStart = score;
        overlayLV.classList.add('hidden');
        resetLevel();
    }

    /* ── Events ── */
    function cellFromEvent(e) {
        const rect = cvs.getBoundingClientRect();
        return {
            col: Math.floor((e.clientX - rect.left) / cs),
            row: Math.floor((e.clientY - rect.top) / cs),
        };
    }

    function onClick(e) {
        if (gamePhase === 'over' || gamePhase === 'complete') return;
        const { col, row } = cellFromEvent(e);
        if (col < 0 || col >= CFG.gridSize || row < 0 || row >= CFG.gridSize) return;
        placePipe(col, row);
    }

    function onMove(e) {
        const { col, row } = cellFromEvent(e);
        if (col === hoverC && row === hoverR) return;
        hoverC = col; hoverR = row;
        draw();
    }

    function onLeave() { hoverC = -1; hoverR = -1; draw(); }

    /* ── Settings ── */
    function initSettings() {
        const optSize = $('opt-size'), optSound = $('opt-sound');
        [optSize, optSound].forEach(el => el.addEventListener('click', e => {
            const btn = e.target.closest('.pill');
            if (!btn) return;
            el.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }));
        $('btn-settings').addEventListener('click', () => overlayST.classList.remove('hidden'));
        $('btn-settings-cancel').addEventListener('click', () => overlayST.classList.add('hidden'));
        $('btn-settings-apply').addEventListener('click', () => {
            const sz = optSize.querySelector('.active');
            const sn = optSound.querySelector('.active');
            if (sz) CFG.gridSize = +sz.dataset.size;
            if (sn) CFG.sound = sn.dataset.sound === 'on';
            initAudio(); newGame();
        });
        overlayST.addEventListener('click', e => { if (e.target === overlayST) overlayST.classList.add('hidden'); });
    }

    /* ── Init ── */
    function init() {
        highScore = +(localStorage.getItem('pipe_hi') || 0);
        cvs = $('game-canvas');
        ctx = cvs.getContext('2d');

        cvs.addEventListener('click', onClick);
        cvs.addEventListener('mousemove', onMove);
        cvs.addEventListener('mouseleave', onLeave);
        cvs.addEventListener('touchstart', e => {
            e.preventDefault();
            onClick({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        }, { passive: false });

        $('btn-new-game').addEventListener('click', () => { initAudio(); newGame(); });
        $('btn-play-again').addEventListener('click', () => { initAudio(); newGame(); });
        $('btn-next-level').addEventListener('click', () => { initAudio(); nextLevel(); });
        overlayGO.addEventListener('click', e => { if (e.target === overlayGO) newGame(); });

        initSettings();
        window.addEventListener('resize', resize);
        document.addEventListener('keydown', e => {
            if (e.key === 'F2')     { e.preventDefault(); initAudio(); newGame(); }
            if (e.key === ' ')      { e.preventDefault(); if (gamePhase === 'prep') { initAudio(); startFlow(); } }
            if (e.key === 'Escape') { overlayST.classList.add('hidden'); overlayGO.classList.add('hidden'); overlayLV.classList.add('hidden'); }
        });

        newGame();
    }

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
