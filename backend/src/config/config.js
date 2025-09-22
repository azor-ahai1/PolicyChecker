import dotenv from 'dotenv';
import path from "path"

dotenv.config({
    path: path.resolve(process.cwd(), '.env')
})

const config = {
    port: process.env.PORT || 4000,
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    policyIndexPath: process.env.POLICY_INDEX_PATH || './policy_index.json',
    driveRootPath: process.env.DRIVE_ROOT_PATH || '/path/to/your/drive/Public Policies',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    uploadDir: process.env.UPLOAD_DIR || 'uploads',
    outputDir: process.env.OUTPUT_DIR || 'outputs',
    nodeEnv: process.env.NODE_ENV || 'development',
    driveFolderId: process.env.DRIVE_FOLDER_ID || "", // Root folder ID containing subfolders
    driveApiCredentials: process.env.DRIVE_API_CREDENTIALS || "", // JSON string of credentials
    frontendURL: process.env.FRONTEND_URL
};

export default config;

