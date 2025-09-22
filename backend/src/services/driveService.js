import { google } from 'googleapis';
import config from '../config/config.js';
import { ApiError } from '../utils/apiError.js';

class OptimizedDriveService {
    constructor() {
        this.drive = null;
        this.initialized = false;
        this.downloadQueue = [];
        this.processingDownloads = false;
        this.maxConcurrentDownloads = 6;
        this.activeDownloads = 0;
        this.downloadCache = new Map();
        this.metadataCache = new Map();
        this.fileListCache = new Map();
        this.requestBatch = [];
        this.batchProcessor = null;
    }

    async initialize() {
        try {
            if (!config.driveApiCredentials) {
                throw new Error('Drive API credentials not found in environment variables');
            }

            const credentials = JSON.parse(config.driveApiCredentials);
            
            const auth = new google.auth.JWT(
                credentials.client_email,
                null,
                credentials.private_key.replace(/\\n/g, '\n'),
                ['https://www.googleapis.com/auth/drive.readonly']
            );

            this.drive = google.drive({ version: 'v3', auth });
            this.initialized = true;
            
            console.log('Google Drive API initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Google Drive API:', error.message);
            throw new ApiError(500, `Failed to initialize Google Drive API: ${error.message}`);
        }
    }

    async ensureInitialized() {
        if (!this.initialized) {
            await this.initialize();
        }
    }

    async listFoldersWithCache(parentFolderId) {
        await this.ensureInitialized();

        const cacheKey = `folders_${parentFolderId}`;
        if (this.fileListCache.has(cacheKey)) {
            console.log(`Cache hit for folder list: ${parentFolderId}`);
            return this.fileListCache.get(cacheKey);
        }

        try {
            const response = await this.drive.files.list({
                q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name)',
                orderBy: 'name',
                pageSize: 100
            });

            const folders = response.data.files || [];
            
            // Cache for 10 minutes
            this.fileListCache.set(cacheKey, folders);
            setTimeout(() => this.fileListCache.delete(cacheKey), 10 * 60 * 1000);
            
            return folders;
        } catch (error) {
            console.error('Error listing folders:', error);
            throw new ApiError(500, `Failed to list folders: ${error.message}`);
        }
    }

    async listPDFFilesWithCache(folderId) {
        await this.ensureInitialized();

        const cacheKey = `pdfs_${folderId}`;
        if (this.fileListCache.has(cacheKey)) {
            console.log(`Cache hit for PDF list: ${folderId}`);
            return this.fileListCache.get(cacheKey);
        }

        try {
            const response = await this.drive.files.list({
                q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
                fields: 'files(id, name, size)',
                orderBy: 'name',
                pageSize: 100
            });

            const files = response.data.files || [];
            
            // Cache for 5 minutes
            this.fileListCache.set(cacheKey, files);
            setTimeout(() => this.fileListCache.delete(cacheKey), 5 * 60 * 1000);
            
            return files;
        } catch (error) {
            console.error('Error listing PDF files:', error);
            throw new ApiError(500, `Failed to list PDF files: ${error.message}`);
        }
    }

    async downloadFileQueued(fileId) {
        return new Promise((resolve, reject) => {
            // Check download cache first
            if (this.downloadCache.has(fileId)) {
                console.log(`Download cache hit: ${fileId}`);
                resolve(this.downloadCache.get(fileId));
                return;
            }

            this.downloadQueue.push({
                fileId,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            this.processDownloadQueue();
        });
    }

    async processDownloadQueue() {
        if (this.processingDownloads || this.downloadQueue.length === 0 || this.activeDownloads >= this.maxConcurrentDownloads) {
            return;
        }

        this.processingDownloads = true;

        while (this.downloadQueue.length > 0 && this.activeDownloads < this.maxConcurrentDownloads) {
            const downloadRequest = this.downloadQueue.shift();
            this.activeDownloads++;
            
            this.executeDownload(downloadRequest).finally(() => {
                this.activeDownloads--;
                // Process next item in queue
                setTimeout(() => this.processDownloadQueue(), 100);
            });
        }

        this.processingDownloads = false;
    }

    async executeDownload(downloadRequest) {
        const { fileId, resolve, reject } = downloadRequest;
        
        try {
            await this.ensureInitialized();
            
            console.log(`Downloading file: ${fileId}`);
            const startTime = Date.now();
            
            const response = await this.drive.files.get({
                fileId: fileId,
                alt: 'media'
            }, {
                responseType: 'arraybuffer'
            });

            const buffer = Buffer.from(response.data);
            const downloadTime = Date.now() - startTime;
            
            console.log(`Downloaded file ${fileId} in ${downloadTime}ms (${buffer.length} bytes)`);
            
            // Cache the download (with size limit)
            if (buffer.length < 5 * 1024 * 1024) { // Cache files under 5MB
                this.downloadCache.set(fileId, buffer);
                // Remove from cache after 30 minutes
                setTimeout(() => this.downloadCache.delete(fileId), 30 * 60 * 1000);
            }
            
            resolve(buffer);
            
        } catch (error) {
            console.error(`Error downloading file ${fileId}:`, error);
            reject(new ApiError(500, `Failed to download file: ${error.message}`));
        }
    }

    async getFileMetadataWithCache(fileId) {
        await this.ensureInitialized();

        if (this.metadataCache.has(fileId)) {
            return this.metadataCache.get(fileId);
        }

        try {
            const response = await this.drive.files.get({
                fileId: fileId,
                fields: 'id, name, size, mimeType, modifiedTime'
            });

            const metadata = response.data;
            
            // Cache metadata for 15 minutes
            this.metadataCache.set(fileId, metadata);
            setTimeout(() => this.metadataCache.delete(fileId), 15 * 60 * 1000);
            
            return metadata;
        } catch (error) {
            console.error('Error getting file metadata:', error);
            throw new ApiError(404, `File not found: ${error.message}`);
        }
    }

    async batchFindPolicyFiles(policyRequests) {
        await this.ensureInitialized();
        
        console.log(`Batch finding ${policyRequests.length} policy files...`);
        
        // Group requests by subfolder to optimize API calls
        const requestsByFolder = new Map();
        policyRequests.forEach(req => {
            if (!requestsByFolder.has(req.subfolderId)) {
                requestsByFolder.set(req.subfolderId, []);
            }
            requestsByFolder.get(req.subfolderId).push(req);
        });

        const results = new Map();
        
        // Process each folder's requests in parallel
        const folderPromises = Array.from(requestsByFolder.entries()).map(async ([subfolderId, requests]) => {
            try {
                // Get all PDF files in this folder at once
                const allFiles = await this.listPDFFilesWithCache(subfolderId);
                
                // Match requests to files
                requests.forEach(req => {
                    const matchingFile = allFiles.find(file => 
                        file.name.toLowerCase().includes(req.policyName.toLowerCase()) ||
                        req.policyName.toLowerCase().includes(file.name.toLowerCase().split('.')[0])
                    );
                    
                    results.set(`${req.subfolderId}_${req.policyName}`, matchingFile || null);
                });
                
            } catch (error) {
                console.error(`Error processing folder ${subfolderId}:`, error.message);
                requests.forEach(req => {
                    results.set(`${req.subfolderId}_${req.policyName}`, null);
                });
            }
        });

        await Promise.allSettled(folderPromises);
        
        console.log(`Batch file search completed. Found ${Array.from(results.values()).filter(r => r !== null).length}/${policyRequests.length} files`);
        return results;
    }

    async batchCheckFilesExist(fileIds) {
        await this.ensureInitialized();
        
        const results = new Map();
        const batchSize = 10;
        
        // Process in batches to avoid overwhelming the API
        for (let i = 0; i < fileIds.length; i += batchSize) {
            const batch = fileIds.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (fileId) => {
                try {
                    // Check metadata cache first
                    if (this.metadataCache.has(fileId)) {
                        return { fileId, exists: true };
                    }
                    
                    await this.drive.files.get({
                        fileId: fileId,
                        fields: 'id'
                    });
                    
                    return { fileId, exists: true };
                } catch (error) {
                    return { fileId, exists: false };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            
            batchResults.forEach(result => {
                if (result.status === 'fulfilled') {
                    results.set(result.value.fileId, result.value.exists);
                } else {
                    results.set(batch[batchResults.indexOf(result)], false);
                }
            });

            // Small delay between batches
            if (i + batchSize < fileIds.length) {
                await this.sleep(200);
            }
        }

        return results;
    }

    async findPolicyFileOptimized(policyName, subfolderId) {
        const request = {
            policyName,
            subfolderId
        };

        const results = await this.batchFindPolicyFiles([request]);
        return results.get(`${subfolderId}_${policyName}`);
    }

    // Legacy methods for backward compatibility
    async listFolders(parentFolderId) {
        return this.listFoldersWithCache(parentFolderId);
    }

    async listPDFFiles(folderId) {
        return this.listPDFFilesWithCache(folderId);
    }

    async downloadFile(fileId) {
        return this.downloadFileQueued(fileId);
    }

    async getFileMetadata(fileId) {
        return this.getFileMetadataWithCache(fileId);
    }

    async findPolicyFile(policyName, subfolderId) {
        return this.findPolicyFileOptimized(policyName, subfolderId);
    }

    async searchFiles(query, folderId = null) {
        await this.ensureInitialized();

        try {
            let searchQuery = query;
            if (folderId) {
                searchQuery = `'${folderId}' in parents and (${query})`;
            }

            const response = await this.drive.files.list({
                q: searchQuery,
                fields: 'files(id, name, parents)',
                orderBy: 'name',
                pageSize: 50
            });

            return response.data.files || [];
        } catch (error) {
            console.error('Error searching files:', error);
            throw new ApiError(500, `Failed to search files: ${error.message}`);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStats() {
        return {
            downloadCacheSize: this.downloadCache.size,
            metadataCacheSize: this.metadataCache.size,
            fileListCacheSize: this.fileListCache.size,
            downloadQueueLength: this.downloadQueue.length,
            activeDownloads: this.activeDownloads,
            maxConcurrentDownloads: this.maxConcurrentDownloads
        };
    }

    clearAllCaches() {
        this.downloadCache.clear();
        this.metadataCache.clear();
        this.fileListCache.clear();
        console.log('All Drive caches cleared');
    }

    adjustConcurrencyLimits(maxDownloads) {
        this.maxConcurrentDownloads = Math.max(1, Math.min(maxDownloads, 10));
        console.log(`Drive download concurrency adjusted to ${this.maxConcurrentDownloads}`);
    }
}

const optimizedDriveService = new OptimizedDriveService();

export default optimizedDriveService;