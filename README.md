# LinkedIn Pinpoint Worker - Cloudflare D1 API

A Cloudflare Worker that scrapes and stores LinkedIn Pinpoint puzzle data using D1 database, with multiple search endpoints.

## 🚀 Features

- **D1 Database Storage**: Store pinpoint number, date, clues, and answers
- **Multiple Search Endpoints**: Search by clue, answer, number, or date
- **Latest Data**: Get today's/latest pinpoint data
- **CRUD Operations**: Add and delete pinpoint data with secret key protection
- **Public API**: All search endpoints are publicly accessible
- **CORS Enabled**: Works with browser requests

## 📊 API Endpoints

### Public Endpoints (No Authentication Required)

| Endpoint | Method | Description | Example |
|----------|--------|-------------|---------|
| `/` | GET | API documentation | Returns all active endpoints |
| `/today` | GET | Get latest pinpoint | Returns highest number entry |
| `/search/number/{number}` | GET | Get by number | `/search/number/458` |
| `/search/date/{date}` | GET | Get by date | `/search/date/2025-08-01` |

### Protected Endpoints (Require Secret Key)

| Method | Endpoint | Description | Example |
|--------|----------|-------------|---------|
| GET | `/add/{number}/{secretkey}` | Scrape and add data | `/add/422/BloggingIo@7` |
| GET | `/delete/{number}/{secretkey}` | Delete data by number | `/delete/422/BloggingIo@7` |

## 🛠️ Setup & Deployment

### Prerequisites
- Node.js (v16 or higher)
- Cloudflare account
- Wrangler CLI

### Installation Steps

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

3. **Create D1 Database**
   ```bash
   wrangler d1 create pinpoint-database
   ```
   
   Copy the `database_id` from output and update `wrangler.toml`

4. **Initialize Database Schema**
   ```bash
   wrangler d1 execute pinpoint-database --file=schema.sql
   ```

5. **Set Secret Key**
   ```bash
   wrangler secret put SECRET_KEY
   ```
   When prompted, enter: `BloggingIo@7`

6. **Deploy to Cloudflare**
   ```bash
   npm run deploy
   ```


   wrangler secret put GITHUB_TOKEN

## 🔧 Development

### Local Development
```bash
npm run dev
```

This starts a local server, usually at `http://localhost:8787`

### View Logs
```bash
npm run tail
```

## 📝 Usage Examples

After deployment, your worker will be available at:
`https://linkedin-pinpoint-worker.{your-subdomain}.workers.dev`

### Get Today's Pinpoint
```bash
curl https://your-worker.workers.dev/today
```

Response:
```json
{
  "success": true,
  "data": {
    "number": 607,
    "date": "2025-01-15",
    "clues": ["Thomas", "Louis", "John's", "Kitts and Nevis", "Petersburg"],
    "answer": "Saints"
  }
}
```

### Add New Pinpoint Data
```bash
curl https://your-worker.workers.dev/add/422/BloggingIo@7
```

Response:
```json
{
  "success": true,
  "message": "Data added/updated successfully",
  "data": {
    "number": 422,
    "date": "2025-06-15",
    "clues": ["Lines", "Phones", "Light", "Ache", "First"],
    "answer": "Words that come after 'head'"
  }
}
```

### Delete Data
```bash
curl https://your-worker.workers.dev/delete/422/BloggingIo@7
```

## 🗄️ Database Schema

```sql
CREATE TABLE pinpoint_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    date TEXT NOT NULL,
    clues TEXT NOT NULL,  -- JSON array
    answer TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🔐 Security

- **Secret Key**: The secret key (`BloggingIo@7`) is stored securely in Cloudflare Secrets
- **Protected Endpoints**: Only `/add` and `/delete` require authentication
- **Public Read Access**: All search endpoints are publicly accessible
- **CORS**: Enabled for browser-based requests

## 📁 Project Structure

```
linkedinpinpoint/
├── src/
│   └── index.js              # Main worker code
├── schema.sql                # D1 database schema
├── wrangler.toml             # Cloudflare configuration
├── package.json              # Dependencies
├── CLOUDFLARE_COMMANDS.txt   # All CLI commands reference
└── README.md                 # This file
```

## 🐛 Troubleshooting

### Check Database Contents
```bash
wrangler d1 execute pinpoint-database --command="SELECT * FROM pinpoint_data LIMIT 10"
```

### View Real-time Logs
```bash
wrangler tail --format=pretty
```

### Test Locally
```bash
wrangler dev --local
```

## 📚 Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [D1 Database Documentation](https://developers.cloudflare.com/d1/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)

## 📄 License

MIT License - Feel free to use and modify as needed.

## 🤝 Contributing

This is a personal project, but suggestions and improvements are welcome!

---

**Note**: Make sure to keep your `SECRET_KEY` secure and never commit it to version control!
