import fs from 'fs/promises';
import config from '../config/config.js';
import { ApiError } from '../utils/apiError.js';

// Create singleton instance
import optimizedDriveService from './driveService.js';

class OptimizedPolicyService {
    constructor() {
        this.policyIndex = [];
        this.isLoaded = false;
        this.folderMapping = new Map();
        this.reverseFolderMapping = new Map(); // Map folder IDs back to names
        this.policyFileIdCache = new Map();
        this.relevanceScoringCache = new Map();
    }

    async loadPolicyIndex() {
        try {
            console.log(`Loading policy index from: ${config.policyIndexPath}`);
            
            try {
                await fs.access(config.policyIndexPath);
            } catch (error) {
                throw new ApiError(500, `Policy index file not found at: ${config.policyIndexPath}`);
            }

            const data = await fs.readFile(config.policyIndexPath, 'utf8');
            const parsedData = JSON.parse(data);
            
            if (!Array.isArray(parsedData)) {
                throw new ApiError(500, 'Policy index file must contain an array of policies');
            }
            
            this.policyIndex = parsedData;
            
            await optimizedDriveService.initialize();
            await this.buildFolderMapping();
            await this.preloadPolicyMetadata();
            
            this.isLoaded = true;
            console.log(`Loaded ${this.policyIndex.length} policies from index`);
            console.log(`Mapped ${this.folderMapping.size} subfolders to Drive folder IDs`);
            
            return this.policyIndex;
        } catch (error) {
            console.error('Error loading policy index:', error.message);
            this.policyIndex = [];
            this.isLoaded = false;
            
            if (error instanceof ApiError) {
                throw error;
            } else {
                throw new ApiError(500, `Failed to load policy index: ${error.message}`);
            }
        }
    }

    async buildFolderMapping() {
        try {
            console.log(`Building folder mapping from Drive folder: ${config.driveFolderId}`);
            
            const subfolders = await optimizedDriveService.listFoldersWithCache(config.driveFolderId);
            
            for (const folder of subfolders) {
                this.folderMapping.set(folder.name, folder.id);
                this.reverseFolderMapping.set(folder.id, folder.name);
                console.log(`Mapped subfolder: ${folder.name} -> ${folder.id}`);
            }
            
        } catch (error) {
            console.error('Error building folder mapping:', error.message);
            throw new ApiError(500, `Failed to build folder mapping: ${error.message}`);
        }
    }

    async preloadPolicyMetadata() {
        console.log('Preloading policy metadata and file IDs...');
        
        // Group policies by subfolder for batch processing
        const policiesByFolder = new Map();
        this.policyIndex.forEach(policy => {
            const subfolder = policy.subfolder;
            if (!policiesByFolder.has(subfolder)) {
                policiesByFolder.set(subfolder, []);
            }
            policiesByFolder.get(subfolder).push(policy);
        });

        const preloadPromises = Array.from(policiesByFolder.entries()).map(async ([subfolder, policies]) => {
            const subfolderId = this.folderMapping.get(subfolder);
            if (!subfolderId) {
                console.log(`Subfolder not found in Drive: ${subfolder}`);
                return;
            }

            try {
                // Get all PDF files in this subfolder at once
                const folderFiles = await optimizedDriveService.listPDFFilesWithCache(subfolderId);
                
                // Match policies to files
                policies.forEach(policy => {
                    const matchingFile = folderFiles.find(file => {
                        const fileName = file.name.toLowerCase();
                        const policyName = policy.pdf_name.toLowerCase();
                        return fileName.includes(policyName.replace('.pdf', '')) || 
                               policyName.includes(fileName.replace('.pdf', ''));
                    });

                    if (matchingFile) {
                        const cacheKey = `${policy.subfolder}_${policy.pdf_name}`;
                        this.policyFileIdCache.set(cacheKey, matchingFile.id);
                    }
                });

                console.log(`Preloaded ${policies.length} policies from folder: ${subfolder}`);
            } catch (error) {
                console.error(`Error preloading folder ${subfolder}:`, error.message);
            }
        });

        await Promise.allSettled(preloadPromises);
        console.log(`Preloaded ${this.policyFileIdCache.size} policy file IDs`);
    }

    async batchCheckPolicyExistence(policies) {
        console.log(`Batch checking existence of ${policies.length} policies...`);
        
        const fileIds = [];
        const policyToFileIdMap = new Map();
        
        // Get file IDs for all policies
        policies.forEach(policy => {
            const cacheKey = `${policy.subfolder}_${policy.pdf_name}`;
            const fileId = this.policyFileIdCache.get(cacheKey);
            
            if (fileId) {
                fileIds.push(fileId);
                policyToFileIdMap.set(policy, fileId);
            }
        });

        if (fileIds.length === 0) {
            return policies.map(() => false);
        }

        // Batch check file existence
        const existenceResults = await optimizedDriveService.batchCheckFilesExist(fileIds);
        
        // Map results back to policies
        return policies.map(policy => {
            const fileId = policyToFileIdMap.get(policy);
            return fileId ? existenceResults.get(fileId) || false : false;
        });
    }
    
    async batchGetPolicyFileIds(policies) {
        const results = new Map();
        const missingPolicies = [];
        
        // Check cache first
        policies.forEach(policy => {
            const cacheKey = `${policy.subfolder}_${policy.pdf_name}`;
            const cachedFileId = this.policyFileIdCache.get(cacheKey);
            
            if (cachedFileId) {
                results.set(policy, cachedFileId);
            } else {
                missingPolicies.push(policy);
            }
        });
        
        if (missingPolicies.length > 0) {
            console.log(`Finding file IDs for ${missingPolicies.length} uncached policies...`);
            
            // Prepare batch requests for missing policies
            const batchRequests = missingPolicies.map(policy => ({
                policyName: policy.pdf_name,
                subfolderId: this.folderMapping.get(policy.subfolder)
            })).filter(req => req.subfolderId);

            if (batchRequests.length > 0) {
                const batchResults = await optimizedDriveService.batchFindPolicyFiles(batchRequests);
                
                missingPolicies.forEach(policy => {
                    const subfolderId = this.folderMapping.get(policy.subfolder);
                    if (subfolderId) {
                        const resultKey = `${subfolderId}_${policy.pdf_name}`;
                        const file = batchResults.get(resultKey);
                        
                        if (file) {
                            results.set(policy, file.id);
                            // Cache for future use
                            const cacheKey = `${policy.subfolder}_${policy.pdf_name}`;
                            this.policyFileIdCache.set(cacheKey, file.id);
                        }
                    }
                });
            }
        }

        return results;
    }

    getPolicyIndex() {
        if (!this.isLoaded) {
            throw new ApiError(500, "Policy index not loaded. Call loadPolicyIndex() first.");
        }
        
        if (!Array.isArray(this.policyIndex)) {
            throw new ApiError(500, "Policy index is not a valid array");
        }
        
        return this.policyIndex;
    }

    getPolicyCount() {
        return this.isLoaded ? this.policyIndex.length : 0;
    }

    findRelevantPolicies(question, maxResults = 10) {
        if (!this.isLoaded) {
            throw new ApiError(500, "Policy index not loaded. Call loadPolicyIndex() first.");
        }

        if (!Array.isArray(this.policyIndex)) {
            throw new ApiError(500, "Policy index is not a valid array");
        }

        if (this.policyIndex.length === 0) {
            console.log('Policy index is empty');
            return [];
        }

        // Create cache key for relevance scoring
        const questionSignature = this.createQuestionSignature(question);
        if (this.relevanceScoringCache.has(questionSignature)) {
            console.log('Relevance scoring cache hit');
            return this.relevanceScoringCache.get(questionSignature);
        }

        // Ensure question has required fields
        const normalizedQuestion = this.normalizeQuestion(question);
        
        console.log(`Searching ${this.policyIndex.length} policies for question: "${normalizedQuestion.text.substring(0, 100)}..."`);

        const scoredPolicies = this.policyIndex.map(policy => {
            const normalizedPolicy = this.normalizePolicy(policy);
            const score = this.calculateRelevanceScore(normalizedQuestion, normalizedPolicy);
            return { ...policy, score };
        });

        // Sort by score and return top results
        const relevantPolicies = scoredPolicies
            .filter(p => p.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);

        console.log(`Found ${relevantPolicies.length} relevant policies with scores:`, 
            relevantPolicies.slice(0, 3).map(p => `${p.pdf_name}: ${p.score}`));

        // Cache the result
        this.relevanceScoringCache.set(questionSignature, relevantPolicies);
        
        // Remove from cache after 30 minutes
        setTimeout(() => this.relevanceScoringCache.delete(questionSignature), 30 * 60 * 1000);

        return relevantPolicies;
    }

    normalizeQuestion(question) {
        return {
            keywords: (question.keywords || []).map(k => String(k).toLowerCase()),
            category: String(question.category || 'Other'),
            text: String(question.text || '').toLowerCase(),
            description: String(question.description || '').toLowerCase()
        };
    }

    normalizePolicy(policy) {
        return {
            keywords: (policy.keywords || []).map(k => String(k).toLowerCase()),
            category: String(policy.category || 'Other'),
            description: String(policy.short_description || '').toLowerCase(),
            name: String(policy.pdf_name || '').toLowerCase()
        };
    }

    calculateRelevanceScore(question, policy) {
        let score = 0;
        
        // Category match (high weight)
        if (policy.category === question.category) {
            score += 50;
        }
        
        // Keyword matching with fuzzy matching
        question.keywords.forEach(qKeyword => {
            policy.keywords.forEach(pKeyword => {
                if (pKeyword.includes(qKeyword) || qKeyword.includes(pKeyword)) {
                    score += 20;
                }
                // Exact match bonus
                if (pKeyword === qKeyword) {
                    score += 30;
                }
                // Fuzzy match bonus
                if (this.fuzzyMatch(pKeyword, qKeyword)) {
                    score += 15;
                }
            });
        });
        
        // Description similarity with keyword presence
        question.keywords.forEach(keyword => {
            if (policy.description.includes(keyword)) {
                score += 10;
            }
        });
        
        // Text content matching in policy name
        question.keywords.forEach(keyword => {
            if (policy.description.includes(keyword) || policy.name.includes(keyword)) {
                score += 5;
            }
        });
        
        // Question text relevance to policy description
        const questionWords = question.text.split(' ').filter(word => word.length > 3);
        questionWords.forEach(word => {
            if (policy.description.includes(word)) {
                score += 3;
            }
        });
        
        return score;
    }

    fuzzyMatch(str1, str2, threshold = 0.7) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length >= threshold;
    }

    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }

    createQuestionSignature(question) {
        const keyData = [
            question.text || '',
            question.category || '',
            (question.keywords || []).sort().join(','),
            question.description || ''
        ].join('|');
        
        return this.simpleHash(keyData);
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString();
    }

    async getPolicyFileId(policyInfo) {
        if (!policyInfo || !policyInfo.subfolder || !policyInfo.pdf_name) {
            throw new ApiError(400, 'Invalid policy info provided');
        }

        const cacheKey = `${policyInfo.subfolder}_${policyInfo.pdf_name}`;
        const cachedFileId = this.policyFileIdCache.get(cacheKey);
        
        if (cachedFileId) {
            return cachedFileId;
        }

        const subfolderId = this.folderMapping.get(policyInfo.subfolder);
        if (!subfolderId) {
            throw new ApiError(404, `Subfolder not found: ${policyInfo.subfolder}`);
        }

        try {
            const file = await optimizedDriveService.findPolicyFileOptimized(policyInfo.pdf_name, subfolderId);
            
            if (!file) {
                throw new ApiError(404, `Policy file not found: ${policyInfo.pdf_name} in ${policyInfo.subfolder}`);
            }

            // Cache the result
            this.policyFileIdCache.set(cacheKey, file.id);
            return file.id;
        } catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, `Error finding policy file: ${error.message}`);
        }
    }

    async checkPolicyExists(policyInfo) {
        try {
            await this.getPolicyFileId(policyInfo);
            return true;
        } catch (error) {
            return false;
        }
    }

    async getPolicyMetadata(policyInfo) {
        try {
            const fileId = await this.getPolicyFileId(policyInfo);
            return await optimizedDriveService.getFileMetadataWithCache(fileId);
        } catch (error) {
            throw new ApiError(404, `Policy metadata not found: ${error.message}`);
        }
    }

    getSubfolderMapping() {
        return Object.fromEntries(this.folderMapping);
    }

    getStats() {
        return {
            policyCount: this.policyIndex.length,
            folderMappings: this.folderMapping.size,
            cachedFileIds: this.policyFileIdCache.size,
            relevanceScoreCache: this.relevanceScoringCache.size,
            driveStats: optimizedDriveService.getStats()
        };
    }

    clearCaches() {
        this.policyFileIdCache.clear();
        this.relevanceScoringCache.clear();
        optimizedDriveService.clearAllCaches();
        console.log('Policy service caches cleared');
    }
}

const optimizedPolicyService = new OptimizedPolicyService();

export default optimizedPolicyService; 