import { createPool } from './db.js';
import { createApp } from './app.js';
import { startCleanups } from './cleanup.js';

const pool = createPool();
const app = createApp(pool);
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`우리학교 시간표 서버 :${port}`));
startCleanups(pool); // 깨어날 때 한 번 + 하루마다 뒷정리(소식 90일 비우기 등)
