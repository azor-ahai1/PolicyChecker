import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/apiError.js';
import { ApiResponse } from '../utils/apiResponse.js';
import pdfService from '../services/pdfService.js';
import optimizedGeminiService from '../services/geminiService.js';
import optimizedPolicyService from '../services/policyService.js';
import optimizedDriveService from '../services/driveService.js';

class ParallelProcessor {
    constructor() {
        this.maxConcurrentQuestions = 3;
        this.maxConcurrentPolicies = 5;
        this.maxConcurrentDownloads = 8;
        this.downloadQueue = [];
        this.processingQueue = [];
        this.cache = new Map();
    }

    async processQuestionsInParallel(questions, policyIndex) {
        const processingStats = {
            totalQuestions: questions.length,
            questionsProcessed: 0,
            totalPoliciesChecked: 0,
            evidenceFound: 0,
            compliantAnswers: 0,
            nonCompliantAnswers: 0,
            cacheHits: 0,
            downloadTime: 0,
            analysisTime: 0
        };

        const evidenceByQuestion = {};

        // Process questions in batches to avoid overwhelming the APIs
        const questionBatches = this.createBatches(questions, this.maxConcurrentQuestions);
        
        for (const batch of questionBatches) {
            console.log(`Processing batch of ${batch.length} questions...`);
            
            const batchPromises = batch.map(question => 
                this.processQuestionParallel(question, policyIndex, processingStats)
            );

            const batchResults = await Promise.allSettled(batchPromises);
            
            // Collect results
            batchResults.forEach((result, index) => {
                const question = batch[index];
                if (result.status === 'fulfilled') {
                    evidenceByQuestion[question.id] = result.value;
                    processingStats.questionsProcessed++;
                } else {
                    console.error(`Error processing question ${question.id}:`, result.reason);
                    evidenceByQuestion[question.id] = [];
                    processingStats.questionsProcessed++;
                }
            });

            // Add delay between batches to respect API rate limits
            if (questionBatches.indexOf(batch) < questionBatches.length - 1) {
                await this.sleep(1000);
            }
        }

        return { evidenceByQuestion, processingStats };
    }

    async processQuestionParallel(question, policyIndex, processingStats) {
        const startTime = Date.now();
        
        try {
            // Find relevant policies
            const relevantPolicies = optimizedPolicyService.findRelevantPolicies(question, 10);
            console.log(`Found ${relevantPolicies.length} relevant policies for question ${question.id}`);
            
            if (relevantPolicies.length === 0) {
                return [];
            }

            // Pre-check policy existence in parallel
            const policyChecks = await this.batchCheckPolicyExistence(relevantPolicies);
            const existingPolicies = relevantPolicies.filter((policy, index) => policyChecks[index]);
            
            if (existingPolicies.length === 0) {
                console.log(`No existing policies found for question ${question.id}`);
                return [];
            }

            // Pre-download all policy files in parallel
            const downloadStartTime = Date.now();
            const policyContents = await this.batchDownloadPolicies(existingPolicies);
            processingStats.downloadTime += Date.now() - downloadStartTime;

            // Process policies in parallel batches
            const candidates = [];
            const policyBatches = this.createBatches(existingPolicies, this.maxConcurrentPolicies);
            
            for (const policyBatch of policyBatches) {
                const analysisStartTime = Date.now();
                
                const batchPromises = policyBatch.map((policy, batchIndex) => {
                    const globalIndex = existingPolicies.findIndex(p => p === policy);
                    const policyText = policyContents[globalIndex];
                    
                    if (!policyText) {
                        return Promise.resolve(null);
                    }
                    
                    return this.analyzyePolicyWithCache(question, policyText, policy);
                });

                const batchResults = await Promise.allSettled(batchPromises);
                processingStats.analysisTime += Date.now() - analysisStartTime;
                
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled' && result.value) {
                        candidates.push(result.value);
                        processingStats.evidenceFound++;
                        processingStats.totalPoliciesChecked++;
                        
                        if (result.value.answer === 'yes') {
                            processingStats.compliantAnswers++;
                        } else if (result.value.answer === 'no') {
                            processingStats.nonCompliantAnswers++;
                        }
                    } else if (result.status === 'fulfilled') {
                        processingStats.totalPoliciesChecked++;
                    }
                });

                // Small delay between policy batches
                if (policyBatches.indexOf(policyBatch) < policyBatches.length - 1) {
                    await this.sleep(500);
                }
            }

            // Sort candidates by confidence and relevance
            candidates.sort((a, b) => {
                const confidenceOrder = { high: 3, medium: 2, low: 1 };
                const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence];
                if (confDiff !== 0) return confDiff;
                
                const answerOrder = { yes: 3, no: 2, partial: 1 };
                const answerDiff = answerOrder[b.answer] - answerOrder[a.answer];
                if (answerDiff !== 0) return answerDiff;
                
                return b.score - a.score;
            });

            console.log(`Question ${question.id} processed in ${Date.now() - startTime}ms with ${candidates.length} evidence items`);
            return candidates;

        } catch (error) {
            console.error(`Error processing question ${question.id}:`, error.message);
            throw error;
        }
    }

    async batchCheckPolicyExistence(policies) {
        return await optimizedPolicyService.batchCheckPolicyExistence(policies);
    }

    async batchDownloadPolicies(policies) {
        const downloadBatches = this.createBatches(policies, this.maxConcurrentDownloads);
        const allContents = [];
        
        for (const batch of downloadBatches) {
            const batchPromises = batch.map(async (policy) => {
                try {
                    // Check cache first
                    const cacheKey = `policy_${policy.subfolder}_${policy.pdf_name}`;
                    if (this.cache.has(cacheKey)) {
                        console.log(`Cache hit for ${policy.pdf_name}`);
                        return this.cache.get(cacheKey);
                    }

                    const fileId = await optimizedPolicyService.getPolicyFileId(policy);
                    const content = await pdfService.extractTextFromDriveFile(fileId);
                    
                    // Cache the content
                    this.cache.set(cacheKey, content);
                    console.log(`Downloaded and cached ${policy.pdf_name}`);
                    
                    return content;
                } catch (error) {
                    console.error(`Failed to download ${policy.pdf_name}:`, error.message);
                    return null;
                }
            });

            const batchContents = await Promise.allSettled(batchPromises);
            allContents.push(...batchContents.map(result => 
                result.status === 'fulfilled' ? result.value : null
            ));

            // Small delay between download batches
            if (downloadBatches.indexOf(batch) < downloadBatches.length - 1) {
                await this.sleep(300);
            }
        }
        
        return allContents;
    }

    async analyzyePolicyWithCache(question, policyText, policy) {
        // Create cache key based on question and policy content hash
        const questionHash = this.simpleHash(question.text);
        const contentHash = this.simpleHash(policyText.substring(0, 1000)); // Use first 1000 chars for hash
        const cacheKey = `analysis_${questionHash}_${contentHash}`;
        
        if (this.cache.has(cacheKey)) {
            console.log(`Analysis cache hit for ${policy.pdf_name}`);
            return this.cache.get(cacheKey);
        }

        try {
            const evidence = await optimizedGeminiService.searchForComplianceEvidence(question, policyText, policy);
            
            // Cache the result
            if (evidence) {
                this.cache.set(cacheKey, evidence);
            }
            
            return evidence;
        } catch (error) {
            console.error(`Analysis failed for ${policy.pdf_name}:`, error.message);
            return null;
        }
    }

    createBatches(array, batchSize) {
        const batches = [];
        for (let i = 0; i < array.length; i += batchSize) {
            batches.push(array.slice(i, i + batchSize));
        }
        return batches;
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    clearCache() {
        this.cache.clear();
        console.log('Cache cleared');
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}

// Create singleton processor
const parallelProcessor = new ParallelProcessor();

const processAuditQuestions = asyncHandler(async (req, res) => {
    // Validate file upload
    if (!req.file) {
        throw new ApiError(400, 'No PDF file uploaded');
    }

    // Validate PDF file
    pdfService.validatePDFFile(req.file);

    const startTime = Date.now();
    console.log(`Processing audit questions from: ${req.file.originalname}`);
    
    try {
        // Extract text from uploaded PDF
        const pdfText = await pdfService.extractTextFromPDF(req.file.path);
        
        if (!pdfText || pdfText.trim().length === 0) {
            throw new ApiError(400, 'Could not extract readable text from PDF');
        }

        console.log(`Extracted ${pdfText.length} characters from PDF`);
        
        // Extract questions using optimized Gemini service
        const questions = await optimizedGeminiService.extractQuestionsFromPDF(pdfText, req.file.originalname);
        console.log(`Extracted ${questions.length} questions`);

        if (questions.length === 0) {
            throw new ApiError(400, 'No audit questions found in the PDF');
        }

        // Get policy index
        const policyIndex = optimizedPolicyService.getPolicyIndex();

        // Process questions in parallel
        const { evidenceByQuestion, processingStats } = await parallelProcessor.processQuestionsInParallel(questions, policyIndex);

        const totalTime = Date.now() - startTime;
        processingStats.totalProcessingTime = totalTime;
        processingStats.averageTimePerQuestion = Math.round(totalTime / questions.length);

        // Prepare response data
        const responseData = {
            questions,
            evidenceByQuestion,
            meta: {
                originalFilename: req.file.originalname,
                questionsCount: questions.length,
                policyIndexCount: policyIndex.length,
                processedAt: new Date().toISOString(),
                processingStats,
                performance: {
                    totalTimeMs: totalTime,
                    downloadTimeMs: processingStats.downloadTime,
                    analysisTimeMs: processingStats.analysisTime,
                    cacheStats: parallelProcessor.getCacheStats()
                },
                driveIntegration: {
                    enabled: true,
                    subfoldersMapping: optimizedPolicyService.getSubfolderMapping()
                }
            }
        };

        console.log(`Processing complete in ${totalTime}ms: ${processingStats.questionsProcessed}/${processingStats.totalQuestions} questions processed`);
        console.log(`Statistics: ${processingStats.totalPoliciesChecked} policies checked, ${processingStats.evidenceFound} evidence found`);
        console.log(`Compliance: ${processingStats.compliantAnswers} YES, ${processingStats.nonCompliantAnswers} NO`);
        console.log(`Performance: ${processingStats.downloadTime}ms download, ${processingStats.analysisTime}ms analysis`);
        
        return res.status(200).json(
            new ApiResponse(200, responseData, "Audit questions processed successfully with parallel optimization")
        );
        
    } finally {
        // Clean up uploaded file
        try {
            await pdfService.deleteTempFile(req.file.path);
        } catch (error) {
            console.error('Error cleaning up temp file:', error.message);
        }
    }
});

// Health check endpoint with cache stats
const healthCheck = asyncHandler(async (req, res) => {
    const policyCount = optimizedPolicyService.getPolicyCount();
    
    // Check Drive connection
    let driveStatus = 'disconnected';
    let driveError = null;
    try {
        await optimizedDriveService.ensureInitialized();
        driveStatus = 'connected';
    } catch (error) {
        driveError = error.message;
    }
    
    return res.status(200).json(
        new ApiResponse(200, {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                policyIndex: policyCount > 0 ? 'loaded' : 'not loaded',
                policyCount: policyCount,
                gemini: 'available',
                googleDrive: driveStatus,
                driveError: driveError,
                subfoldersMapping: driveStatus === 'connected' ? optimizedPolicyService.getSubfolderMapping() : null
            },
            performance: {
                cacheStats: parallelProcessor.getCacheStats(),
                policyServiceStats: optimizedPolicyService.getStats(),
                driveServiceStats: optimizedDriveService.getStats(),
                geminiServiceStats: optimizedGeminiService.getQueueStats(),
                concurrencyLimits: {
                    questions: parallelProcessor.maxConcurrentQuestions,
                    policies: parallelProcessor.maxConcurrentPolicies,
                    downloads: parallelProcessor.maxConcurrentDownloads
                }
            }
        }, "Service is healthy with performance optimizations")
    );
});

// Clear cache endpoint for debugging
const clearCache = asyncHandler(async (req, res) => {
    parallelProcessor.clearCache();
    return res.status(200).json(
        new ApiResponse(200, { cleared: true }, "Cache cleared successfully")
    );
});

export { processAuditQuestions, healthCheck, clearCache };