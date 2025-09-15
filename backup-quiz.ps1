# backup-quiz.ps1

# Create timestamp in format YYYY-MM-DD_HH-MM-SS
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

# Copy quiz.db to a backup file with timestamp
Copy-Item "quiz.db" ("quiz.db.bak_" + $timestamp)

# Optional: start the server automatically after backup
node server.js
