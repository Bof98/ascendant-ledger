# Security Policy

Ascendant Ledger processes financial exports and should be treated as sensitive software even though the data comes from a game.

## Deployment guidance

- Keep authentication enabled when the service is reachable beyond a trusted LAN.
- Use HTTPS through a reverse proxy for remote access.
- Use a strong `SESSION_SECRET` and administrator password.
- Keep Docker, Node base images, and dependencies updated.
- Back up the SQLite database before upgrades.
- Do not publish database files, CSV exports, or logs containing private company information.

## Reporting a vulnerability

Please use GitHub Private Vulnerability Reporting when it is enabled for the repository, or contact the repository maintainer privately. Do not open a public issue containing exploit details, credentials, CSV exports, or user data.
