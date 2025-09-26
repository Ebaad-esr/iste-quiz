/*
QuizApp — single-file Node.js server + frontend
Filename: server.js
MODEL: Admin-Controlled Live Event (Hybrid Paced with Pre-Join Lobby)
DATABASE: SQLite (for local hosting)
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const path = require('path');

const APP_PORT = process.env.PORT || 3001;
const ADMIN_PASS = process.env.ADMIN_PASS || '3gbup38id9'; // change this or set env

// Prepare database
const questionsDbFile = path.join(__dirname, 'questions.db');
const resultsDbFile = path.join(__dirname, 'results.db');
const questionsDb = new Database(questionsDbFile);
const resultsDb = new Database(resultsDbFile);


// Create tables if missing
questionsDb.exec(`
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  choices TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  time_limit INTEGER NOT NULL,
  points INTEGER NOT NULL,
  negative_points INTEGER NOT NULL DEFAULT 0
);
`);

resultsDb.exec(`
CREATE TABLE IF NOT EXISTS results (
  name TEXT PRIMARY KEY,
  branch TEXT,
  year INTEGER,
  score INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
`);

// In-memory state
const quizSession = { running: false };
const playerState = new Map(); // socket.id -> { name, branch, year, score, questionIndex, questionOrder }

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Player page
app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" /><title>Live Quiz</title><meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root{--primary-bg:#5a8fbb;--card-bg:#ffffff;--button-bg:#0a2d4d;--button-hover-bg:#1c5d99;--accent-color:#e83e8c;--text-light:#ffffff;--text-dark:#333333;--text-muted:#6c757d; --correct-bg: #28a745; --incorrect-bg: #dc3545;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Lato',Arial,sans-serif;background-color:var(--primary-bg);color:var(--text-dark);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;padding-top:100px;}
    .hidden{display:none !important;}
    .app-header{position:fixed;top:0;left:0;width:100%;height:80px;background-color:var(--card-bg);display:flex;justify-content:space-between;align-items:center;padding:0 30px;box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:10;}
    .header-left { display: flex; align-items: center; }
    .header-logo{height:55px; width: auto;}
    #college-logo{height: 75px;}
    .header-title{font-size:1.5rem;font-weight:bold;color:var(--button-bg); margin-left: 20px;}
    #player-count{font-size:1.2rem;color:var(--text-muted);}
    .card{background-color:var(--card-bg);border-radius:15px;box-shadow:0 10px 25px rgba(0,0,0,0.1);padding:30px 40px;width:100%;max-width:600px;text-align:center;}
    h1,h2,h3{margin-bottom:20px;}
    #qPrompt{font-size:1.25rem;margin-bottom:30px;min-height:50px;}
    .choices-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-bottom:30px;}
    .choice-container .hidden-radio{display:none;}
    .choice-container .choice-label{display:flex;justify-content:space-between;align-items:center;padding:15px;background-color:var(--button-bg);color:var(--text-light);border-radius:10px;cursor:pointer;transition:background-color 0.2s ease-in-out;text-align:left;}
    .choice-container .choice-label:hover{background-color:var(--button-hover-bg);}
    .choice-indicator{width:24px;height:24px;border:2px solid var(--text-light);border-radius:50%;margin-left:15px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all 0.2s ease;}
    .hidden-radio:checked + .choice-label{background-color:var(--button-hover-bg);box-shadow:inset 0 0 0 2px var(--text-light);}
    .hidden-radio:checked + .choice-label .choice-indicator::after{content:'';width:12px;height:12px;background-color:var(--text-light);border-radius:50%;}
    .correct-answer { background-color: var(--correct-bg) !important; }
    .incorrect-answer { background-color: var(--incorrect-bg) !important; }
    .btn{padding:15px 40px;background-color:var(--accent-color);color:var(--text-light);border:none;border-radius:10px;font-size:1rem;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-block;transition:opacity 0.2s ease;}
    .btn:hover{opacity:0.9;}
    .btn-block{width:100%;display:block;padding:15px;}
    #infoBar{display:grid;grid-template-columns:1fr 1fr 1fr;color:var(--text-muted);margin-top:15px;margin-bottom:20px;font-size:0.9rem;}
    #joinDiv input, #joinDiv select {display:block;width:100%;padding:10px;margin-bottom:20px;border-radius:5px;border:1px solid #ccc;font-size:1rem;}
  </style>
</head>
<body>
  <header class="app-header">
      <div class="header-left">
        <img src="/ssgmce-logo.jpg" alt="College Logo" class="header-logo" id="college-logo">
        <div class="header-title">EMW Class Quiz</div>
      </div>
      <div id="player-count">Players: 0</div>
  </header>
  <div id="joinDiv" class="card hidden">
    <h1>Quiz Challenge</h1>
    <input id="name" maxlength="24" placeholder="Enter your name" required />
    <input id="branch" maxlength="24" placeholder="Your Branch (e.g., Comp)" required />
    <input id="year" type="number" placeholder="Your Year (e.g., 2)" required />
    <button id="joinBtn" class="btn btn-block">Join Quiz</button>
  </div>
  <div id="waitingDiv" class="card"><h2 id="waitingMessage">Connecting...</h2><p id="waitingSubtext"></p></div>
  <div id="quizDiv" class="card hidden"><p id="qPrompt">Loading first question...</p><div id="choices" class="choices-grid"></div><div id="infoBar"><span>Time left: <strong id="timer">0</strong>s</span><span>Your Score: <strong id="totalScore">0</strong></span><span>(Score/Negative): <strong id="question-score">0 / 0</strong></span></div><button id="submitBtn" class="btn">Next</button></div>
  <div id="finishedDiv" class="card hidden">
    <h2>Quiz Completed!</h2>
    <h3>Your Final Score:</h3>
    <p id="finalScore" style="font-size: 3rem; font-weight: bold; margin-bottom: 20px;">0</p>
    <a href="/leaderboard" class="btn">View Leaderboard</a>
  </div>
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    let myName = null;
    let currentQuestion = null;
    let timerInterval = null;

    const joinDiv = document.getElementById("joinDiv");
    const waitingDiv = document.getElementById("waitingDiv");
    const waitingMessage = document.getElementById("waitingMessage");
    const waitingSubtext = document.getElementById("waitingSubtext");
    const quizDiv = document.getElementById("quizDiv");
    const finishedDiv = document.getElementById("finishedDiv");
    const finalScoreEl = document.getElementById("finalScore");

    socket.on('connect', () => {
        socket.emit("requestQuizState");
    });
    
    socket.on('quizState', (state) => {
         if (joinDiv.classList.contains('hidden') && waitingMessage.innerText.startsWith("Welcome")) {
             return;
         }
         if (state.running) {
            joinDiv.classList.add('hidden');
            waitingMessage.innerText = "Quiz In Progress";
            waitingSubtext.innerText = "Please wait for the next round to begin.";
            waitingDiv.classList.remove('hidden');
         } else {
            joinDiv.classList.remove('hidden');
            waitingDiv.classList.add('hidden');
         }
    });

    document.getElementById("joinBtn").addEventListener("click", () => {
        const name = document.getElementById("name").value.trim();
        const branch = document.getElementById("branch").value.trim();
        const year = document.getElementById("year").value.trim();
        if (!name || !branch || !year) {
            alert("Please fill in all fields.");
            return;
        }
        myName = name;
        socket.emit("join", { name: name, branch: branch, year: year });
        joinDiv.classList.add("hidden");
        waitingMessage.innerText = "Welcome, " + name + "!";
        waitingSubtext.innerText = "Waiting for the admin to start the quiz...";
        waitingDiv.classList.remove("hidden");
    });

    socket.on("playerCountUpdate", count => {
        document.getElementById("player-count").innerText = "Players: " + count;
    });

    socket.on("question", e => {
        currentQuestion = e;
        waitingDiv.classList.add("hidden");
        quizDiv.classList.remove("hidden");
        document.getElementById("qPrompt").innerText = e.prompt;
        document.getElementById("choices").innerHTML = e.choices.map((choice, t) => \`<div class="choice-container"><input type="radio" id="choice-\${t}" name="choice" value="\${t}" class="hidden-radio"><label for="choice-\${t}" class="choice-label"><span class="choice-text">\${choice}</span><span class="choice-indicator"></span></label></div>\`).join("");
        document.getElementById("question-score").innerText = \`\${e.points} / -\${e.negative_points}\`;
        const t = document.getElementById("timer");
        const o = e.startAt + 1e3 * e.time_limit;
        timerInterval && clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const n = Math.max(0, Math.ceil((o - Date.now()) / 1e3));
            t.innerText = n;
            if (n <= 0) {
                clearInterval(timerInterval);
                submitAnswer();
            }
        }, 200);
        const n = document.getElementById("submitBtn");
        if (n) {
            n.disabled = false;
            n.classList.remove('hidden');
        }
    });

    function submitAnswer() {
        if (!currentQuestion) return;
        const e = document.getElementsByName("choice");
        let t = -1;
        for (const o of e)
            if (o.checked) {
                t = parseInt(o.value);
                break
            }
        document.querySelectorAll(".choice-container input").forEach(radio => radio.disabled = true);
        document.getElementById("submitBtn").classList.add('hidden');
        socket.emit("submitAnswer", {
            question_id: currentQuestion.id,
            selected: t
        });
    }
    document.getElementById("submitBtn").addEventListener("click", submitAnswer);

    socket.on("answerResult", (data) => {
        const { correct_index, selected_index } = data;
        const labels = document.querySelectorAll('.choice-label');

        if (selected_index === correct_index) {
            if (labels[selected_index]) {
                labels[selected_index].classList.add('correct-answer');
            }
        } else {
            if (selected_index >= 0) {
                labels[selected_index].classList.add('incorrect-answer');
            }
            if (labels[correct_index]) {
                labels[correct_index].classList.add('correct-answer');
            }
        }
    });

    socket.on("yourScore", e => {
        const t = document.getElementById("totalScore");
        t && (t.innerText = e.score || 0)
    });

    socket.on("quizFinished", (data) => {
        quizDiv.classList.add("hidden");
        if (finishedDiv && finalScoreEl) {
            finalScoreEl.innerText = data.score;
            finishedDiv.classList.remove("hidden");
        }
    });
</script>
</body></html>`);
});

// Live Leaderboard Page
app.get('/leaderboard', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" /><title>Leaderboard</title><meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root{--primary-bg:#5a8fbb;--card-bg:#ffffff;--button-bg:#0a2d4d;--button-hover-bg:#1c5d99;--accent-color:#e83e8c;--text-light:#ffffff;--text-dark:#333333;--text-muted:#6c757d;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Lato',Arial,sans-serif;background-color:var(--primary-bg);color:var(--text-dark);display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;padding:20px;padding-top:100px;}
    .app-header{position:fixed;top:0;left:0;width:100%;height:80px;background-color:var(--card-bg);display:flex;justify-content:space-between;align-items:center;padding:0 30px;box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:10;}
    .header-left { display: flex; align-items: center; }
    .header-logo{height:55px; width: auto;}
    #college-logo{height: 75px;}
    .header-title{font-size:1.5rem;font-weight:bold;color:var(--button-bg); margin-left: 20px;}
    #player-count{font-size:1.2rem;color:var(--text-muted);}
    .card{background-color:var(--card-bg);border-radius:15px;box-shadow:0 10px 25px rgba(0,0,0,0.1);padding:30px 40px;width:100%;max-width:800px;text-align:center;}
    h1{margin-bottom:20px;}
    .table-wrapper { overflow-x: auto; }
    table{width:100%;border-collapse:collapse;margin-top:20px;}
    th,td{padding:12px 15px;text-align:left;border-bottom:1px solid #dee2e6;}
    th{font-weight:bold; color:#6c757d;}
    .rank-1{background-color: #fff7d6 !important; font-size: 1.5em; font-weight: bold;}
    .rank-2{background-color: #f0f0f0 !important; font-size: 1.2em;}
    .rank-3{background-color: #ffe8d6 !important; font-size: 1.2em;}
    @media (max-width: 600px) {
        h1 { font-size: 1.5rem; }
        .rank-1 { font-size: 1.2em; }
        .rank-2, .rank-3 { font-size: 1.1em; }
    }
  </style>
</head>
<body>
  <header class="app-header">
      <div class="header-left">
        <img src="/ssgmce-logo.jpg" alt="College Logo" class="header-logo" id="college-logo">
        <div class="header-title">EMW Class Quiz</div>
      </div>
      <div id="player-count">Total Players: 0</div>
  </header>
  <div class="card">
    <h1>Top 20 Players</h1>
    <div class="table-wrapper">
        <table>
          <thead><tr><th>Rank</th><th>Name</th><th>Branch</th><th>Year</th><th>Score</th></tr></thead>
          <tbody id="leaderboard-body"></tbody>
        </table>
    </div>
  </div>
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    const leaderboardBody = document.getElementById("leaderboard-body");
    const playerCountEl = document.getElementById("player-count");

    socket.on('connect', () => {
        socket.emit("requestQuizState");
    });

    socket.on('quizState', e => {
        updateLeaderboard(e.leaderboard || []);
        if (e.totalPlayers !== undefined) {
            playerCountEl.innerText = "Total Players: " + e.totalPlayers;
        }
    });

    socket.on('leaderboardUpdate', data => {
        updateLeaderboard(data.leaderboard || []);
        if (data.totalPlayers !== undefined) {
            playerCountEl.innerText = "Total Players: " + data.totalPlayers;
        }
    });

    function getMedal(rank) {
        if (rank === 1) return '🥇';
        if (rank === 2) return '🥈';
        if (rank === 3) return '🥉';
        return rank;
    }

    function updateLeaderboard(e) {
        leaderboardBody.innerHTML = e.map((r, t) =>
            \`<tr class="rank-\${t+1}">
                <td>\${getMedal(t+1)}</td>
                <td>\${r.name}</td>
                <td>\${r.branch}</td>
                <td>\${r.year}</td>
                <td>\${r.score}</td>
            </tr>\`
        ).join("")
    }
</script>
</body></html>`);
});

// Admin page
app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8"><title>Quiz Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root{--bg-light:#f8f9fa;--card-bg:#ffffff;--primary:#0d6efd;--success:#198754;--warning:#ffc107;--danger:#dc3545;--text-dark:#212529;--text-muted:#6c757d;--border-color:#dee2e6;}
        *{box-sizing:border-box;margin:0;padding:0;} body{font-family:'Lato',sans-serif;background-color:var(--bg-light);color:var(--text-dark);font-size:16px;} .hidden{display:none !important;} .dashboard{max-width:1200px;margin:30px auto;padding:20px;} header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;} header h1{font-size:2rem;} .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px;margin-bottom:30px;} .stat-card{background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;padding:20px;text-align:center;} .stat-card h3{font-size:1.1rem;color:var(--text-muted);margin-bottom:10px;} .stat-card p{font-size:2.5rem;font-weight:bold;} .status-running{color:var(--success);} .status-idle{color:var(--danger);} .main-card{background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;padding:20px;} .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;} .card-header h2{font-size:1.5rem;margin:0;} button{cursor:pointer;border-radius:6px;padding:10px 15px;font-size:1rem;border:1px solid transparent;font-weight:bold;transition:all 0.2s ease;} .btn-primary{background-color:var(--primary);color:white;} .btn-primary:hover{opacity:0.9;} .btn-danger{background-color:var(--danger);color:white;} .btn-danger:hover{opacity:0.9;} .btn-success{background-color:var(--success);color:white;} .btn-success:hover{opacity:0.9;} table{width:100%;border-collapse:collapse;} th,td{text-align:left;padding:12px;border-bottom:1px solid var(--border-color);} th{font-weight:bold;color:var(--text-muted);} #qform{background-color:#f8f9fa;padding:20px;border-radius:8px;margin-top:20px;border:1px solid var(--border-color);} #qform div{margin-bottom:15px;} #qform input{width:100%;padding:10px;border:1px solid var(--border-color);border-radius:6px;} .login-card{max-width:400px;margin:100px auto;}
    </style>
</head>
<body>
    <div id="loginArea" class="card login-card"><h1>Admin Login</h1><label>Passphrase: <input id="pass" type="password" style="width:100%;padding:10px;margin-top:5px;margin-bottom:15px;"></label><button id="loginBtn" class="btn-primary" style="width:100%;">Login</button></div>
    <div id="adminArea" class="dashboard hidden"><header><h1>Quiz Dashboard</h1></header><div class="stats-grid"><div class="stat-card"><h3>Total Questions</h3><p id="stat-questions">0</p></div><div class="stat-card"><h3>Waiting Players</h3><p id="stat-players">0</p></div><div class="stat-card"><h3>Quiz Status</h3><p id="stat-status">Idle</p></div></div><div class="main-card"><div class="card-header"><h2>Quiz Control</h2><div><button id="startQuiz" class="btn-success">Start Quiz</button><button id="endQuiz" class="btn-danger">End Quiz Now</button></div></div></div><br><div class="main-card"><div class="card-header"><h2>Question Management</h2><button id="toggleFormBtn" class="btn-primary">+ Add Question</button></div><form id="qform" class="hidden"><h3>New Question</h3><div><input name="prompt" required placeholder="Question Prompt"></div><div><input name="choices" required placeholder="Choices (comma-separated)"></div><div><input name="answer_index" value="0" placeholder="Answer index (0-based)"></div><div><input name="time_limit" value="10" placeholder="Time limit (seconds)"></div><div><input name="points" value="10" placeholder="Points"></div><div><input name="negative_points" value="5" placeholder="Negative Points"></div><button>Save Question</button></form><table><thead><tr><th>ID</th><th>Prompt</th><th>Time</th><th>Points</th><th>Action</th></tr></thead><tbody id="qList"></tbody></table></div></div>
<script>
let refreshInterval=null;
async function api(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});return r.json()}
async function refreshDashboard(){const pass=document.getElementById("pass").value;const stats=await api("/admin/stats",{pass});if(stats.ok){document.getElementById("stat-questions").innerText=stats.totalQuestions;document.getElementById("stat-players").innerText=stats.playersOnline;const statusEl=document.getElementById("stat-status");statusEl.innerText=stats.quizStatus;statusEl.className=stats.quizStatus==="Running"?"status-running":"status-idle";}
const list=await api("/admin/list",{pass});if(list.ok){document.getElementById("qList").innerHTML=list.questions.map(q=>\`<tr><td>#\${q.id}</td><td>\${q.prompt}</td><td>\${q.time_limit}s</td><td>\${q.points}</td><td><button class="btn-danger" onclick="del(\${q.id})">Del</button></td></tr>\`).join("")}}
document.getElementById("loginBtn").addEventListener("click",async()=>{const pass=document.getElementById("pass").value;const res=await api("/admin/check",{pass});if(res.ok){document.getElementById("loginArea").classList.add("hidden");document.getElementById("adminArea").classList.remove("hidden");refreshDashboard();refreshInterval=setInterval(refreshDashboard,5000)}else{alert("Bad passphrase")}});
document.getElementById("toggleFormBtn").addEventListener("click",()=>document.getElementById("qform").classList.toggle("hidden"));
document.getElementById("qform").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;const body={pass:document.getElementById("pass").value,prompt:f.prompt.value,choices:f.choices.value.split(",").map(s=>s.trim()),answer_index:parseInt(f.answer_index.value||0),time_limit:parseInt(f.time_limit.value||10),points:parseInt(f.points.value||10),negative_points:parseInt(f.negative_points.value||0)};const r=await api("/admin/add-question",body);if(r.ok){f.reset();document.getElementById("qform").classList.add("hidden");refreshDashboard()}else{alert("Error adding question")}});
window.del=async id=>{if(confirm("Are you sure?")){const r=await api("/admin/delete",{pass:document.getElementById("pass").value,id});if(r.ok)refreshDashboard()}};
document.getElementById("startQuiz").addEventListener("click",async()=>{const r=await api("/admin/start",{pass:document.getElementById("pass").value});if(r.ok){alert("Quiz started");refreshDashboard()}else{alert("Error starting quiz")}});
document.getElementById("endQuiz").addEventListener("click",async()=>{const r=await api("/admin/end",{pass:document.getElementById("pass").value});if(r.ok){alert("Quiz ended");refreshDashboard()}else{alert("Error ending quiz")}});
</script>
</body></html>`);
});

// Admin endpoints
app.post('/admin/check', (req, res) => {
    res.json({ ok: (req.body.pass || '') === ADMIN_PASS });
});

app.post('/admin/stats', (req, res) => {
    if ((req.body.pass || '') !== ADMIN_PASS) return res.json({ ok: false });
    const count = questionsDb.prepare('SELECT COUNT(*) as count FROM questions').get();
    res.json({ ok: true, totalQuestions: count.count, playersOnline: playerState.size, quizStatus: quizSession.running ? 'Running' : 'Idle' });
});

app.post('/admin/add-question', (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.json({ ok: false });
  const { prompt, choices, answer_index, time_limit, points, negative_points } = req.body;
  questionsDb.prepare('INSERT INTO questions (prompt, choices, answer_index, time_limit, points, negative_points) VALUES (?,?,?,?,?,?)').run(prompt, JSON.stringify(choices), answer_index|0, time_limit|0, points|0, negative_points|0);
  res.json({ ok: true });
});

app.post('/admin/list', (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.json({ ok: false });
  const rows = questionsDb.prepare('SELECT id,prompt,time_limit,points FROM questions ORDER BY id DESC').all();
  res.json({ ok: true, questions: rows });
});

app.post('/admin/delete', (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.json({ ok:false });
  questionsDb.prepare('DELETE FROM questions WHERE id = ?').run(req.body.id);
  res.json({ ok:true });
});

app.post('/admin/start', (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.json({ ok:false });
  quizSession.running = true;
  resultsDb.prepare('DELETE FROM results').run();
  
  const allQuestionIds = questionsDb.prepare('SELECT id FROM questions ORDER BY id').all().map(r => r.id);
  for (const [id, socket] of io.of("/").sockets) {
      if (playerState.has(id)) {
          const state = playerState.get(id);
          state.questionOrder = allQuestionIds;
          state.questionIndex = -1;
          state.score = 0;
          sendNextQuestion(socket);
      }
  }

  io.emit('quizState', { running: true, leaderboard: [] });
  res.json({ ok:true });
});

app.post('/admin/end', (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.json({ ok:false });
  quizSession.running = false;
  const totalPlayers = resultsDb.prepare('SELECT COUNT(*) as count FROM results').get().count;
  io.emit('quizState', { running: false, leaderboard: getLeaderboard(), totalPlayers: totalPlayers });
  res.json({ ok:true });
});

// Utility
function getQuestionById(id){
  const row = questionsDb.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? { ...row, choices: JSON.parse(row.choices) } : null;
}
function getLeaderboard() {
    return resultsDb.prepare('SELECT name, branch, year, score FROM results ORDER BY score DESC, timestamp ASC LIMIT 20').all();
}

// Socket.IO Logic
io.on('connection', (socket)=>{
  io.emit('playerCountUpdate', playerState.size);
  socket.on("requestQuizState", () => {
    const totalPlayers = resultsDb.prepare('SELECT COUNT(*) as count FROM results').get().count;
    socket.emit("quizState", { running: quizSession.running, leaderboard: getLeaderboard(), totalPlayers: totalPlayers });
  });

  socket.on('join', (data)=>{
    const { name, branch, year } = data || {};
    playerState.set(socket.id, { name, branch, year, score: 0 });
    io.emit('playerCountUpdate', playerState.size);
    
    if (quizSession.running) {
        const state = playerState.get(socket.id);
        state.questionOrder = questionsDb.prepare('SELECT id FROM questions ORDER BY id').all().map(r => r.id);
        state.questionIndex = -1;
        sendNextQuestion(socket);
    }
  });
  
  socket.on('submitAnswer', (data) => {
    const state = playerState.get(socket.id);
    if (!state || !quizSession.running) return;

    const { question_id, selected } = data;
    const currentQuestionId = state.questionOrder[state.questionIndex];
    
    if (question_id === currentQuestionId) {
        const q = getQuestionById(question_id);
        if (q) {
            const isCorrect = selected === q.answer_index;
            if (isCorrect) {
                state.score += q.points;
            } else if (selected !== -1) {
                state.score -= q.negative_points;
            }
            socket.emit('answerResult', { correct_index: q.answer_index, selected_index: selected });
        }
        socket.emit('yourScore', { score: state.score });

        const stmt = resultsDb.prepare('INSERT INTO results (name, branch, year, score, timestamp) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET score=excluded.score, timestamp=excluded.timestamp');
        stmt.run(state.name, state.branch, state.year, state.score, Date.now());
        
        const totalPlayers = resultsDb.prepare('SELECT COUNT(*) as count FROM results').get().count;
        io.emit('leaderboardUpdate', { leaderboard: getLeaderboard(), totalPlayers: totalPlayers });
    }
    
    setTimeout(() => sendNextQuestion(socket), 1000); // Wait 1s before next question
});

  socket.on('disconnect', () => { 
      playerState.delete(socket.id);
      io.emit('playerCountUpdate', playerState.size);
  });
});

function sendNextQuestion(socket) {
    const state = playerState.get(socket.id);
    if (!state) return;
    state.questionIndex++;

    if (state.questionIndex >= state.questionOrder.length) {
        socket.emit('quizFinished', { score: state.score });
    } else {
        const nextQuestionId = state.questionOrder[state.questionIndex];
        const q = getQuestionById(nextQuestionId);
        if (q) {
            socket.emit('question', { ...q, startAt: Date.now() });
        } else {
            sendNextQuestion(socket);
        }
    }
}

process.on('SIGINT', ()=>{ console.log('shutting down...'); server.close(()=>process.exit(0)); });
server.listen(APP_PORT, ()=>{
  console.log(`Live quiz server running in Pune on port ${APP_PORT}. Have a wonderful Saturday evening!`);
  console.log(`Open http://localhost:${APP_PORT} for players and /admin for the dashboard.`);
});
