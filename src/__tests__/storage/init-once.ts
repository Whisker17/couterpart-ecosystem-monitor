// Helper script: initialize DB singleton and exit cleanly.
// Used by concurrent-startup regression test.
import { getDb, closeDb } from "../../storage/db.js";
getDb();
closeDb();
