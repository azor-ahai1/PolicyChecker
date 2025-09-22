import { getGeminiModel } from '../config/gemini.js';
import { ApiError } from '../utils/apiError.js';

class OptimizedGeminiService {
    constructor() {
        this.maxRetries = 3;
        this.baseDelay = 1000;
        this.requestQueue = [];
        this.processingQueue = false;
        this.maxConcurrentRequests = 3;
        this.activeRequests = 0;
        this.requestHistory = [];
        this.adaptiveDelay = 1000;
    }

    async extractQuestionsFromPDF(pdfText, filename) {
        // Check if document is very large and needs chunking
        const maxTextLength = 30000;
        
        if (pdfText.length > maxTextLength * 2) {
            console.log('Document is very large, processing in chunks with parallel processing...');
            return await this.extractQuestionsInChunksParallel(pdfText, filename, maxTextLength);
        }
        
        const truncatedText = pdfText.length > maxTextLength 
            ? pdfText.substring(0, maxTextLength) + '...[truncated]'
            : pdfText;

        return await this.processTextChunk(truncatedText, filename, 1, 1);
    }

    async extractQuestionsInChunksParallel(pdfText, filename, chunkSize) {
        const chunks = this.splitTextIntoChunks(pdfText, chunkSize);
        const allQuestions = [];
        let questionIdCounter = 1;

        console.log(`Processing ${chunks.length} chunks in parallel...`);

        // Process chunks in parallel batches
        const chunkBatches = this.createBatches(chunks, 2); // 2 chunks at a time to avoid overwhelming API
        
        for (const batch of chunkBatches) {
            const batchPromises = batch.map((chunk, index) => {
                const chunkIndex = chunks.indexOf(chunk);
                return this.processTextChunk(chunk, filename, chunkIndex + 1, chunks.length);
            });
            
            try {
                const batchResults = await Promise.allSettled(batchPromises);
                
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled' && result.value) {
                        const questions = result.value;
                        questions.forEach(q => {
                            q.id = questionIdCounter++;
                        });
                        allQuestions.push(...questions);
                    } else {
                        console.error(`Chunk processing failed:`, result.reason);
                    }
                });
                
                // Adaptive delay based on API response times
                if (chunkBatches.indexOf(batch) < chunkBatches.length - 1) {
                    await this.sleep(this.adaptiveDelay);
                }
            } catch (error) {
                console.error(`Error processing chunk batch:`, error.message);
            }
        }

        console.log(`Extracted ${allQuestions.length} questions from ${chunks.length} chunks`);
        return allQuestions;
    }

    async processTextChunk(text, filename, chunkNumber, totalChunks) {
        const chunkInfo = totalChunks > 1 ? ` (chunk ${chunkNumber}/${totalChunks})` : '';
        
        const prompt = `You are an audit question extractor. Extract audit compliance questions from this document${chunkInfo} and return them as a structured JSON array.

Focus on extracting questions that:
- Ask "Does the P&P state..."  
- Require Yes/No answers with specific policy citations
- Reference specific regulatory requirements or APL sections
- Ask about compliance with contractual obligations

IMPORTANT: You MUST return complete, valid JSON. Ensure all JSON objects are properly closed.

Return ONLY valid JSON in this exact format (no markdown, no explanations):

{
  "questions": [
    {
      "id": 1,
      "text": "Full question text here - must be the exact compliance question",
      "category": "Clinical/Medical",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "description": "Brief description of what this question seeks to verify",
      "requiresEvidence": true
    }
  ]
}

Categories: Clinical/Medical, Claims & Appeals, Access & Authorization, Privacy & Security, Provider Relations, HR, Financial Compliance, IT Security, Operations, Legal, Other

Guidelines:
- Extract only questions that require definitive Yes/No compliance answers
- Focus on "Does the P&P state..." format questions
- Include regulatory references, time periods, specific requirements in keywords  
- Keep descriptions under 150 characters
- Set requiresEvidence to true for all compliance questions
- Ensure JSON is complete and valid - double-check closing braces and quotes

Document: ${filename}${chunkInfo}
Content: ${text}`;

        try {
            const result = await this.queuedGeminiRequest(prompt, 'question_extraction');
            const parsedResult = this.parseJSONResponse(result, true);
            
            if (!parsedResult.questions || !Array.isArray(parsedResult.questions)) {
                throw new ApiError(500, 'Invalid response format from AI model');
            }
            
            return parsedResult.questions;
        } catch (error) {
            console.error(`Error extracting questions from chunk ${chunkNumber}:`, error);
            throw new ApiError(500, `Failed to extract questions: ${error.message}`);
        }
    }

    async searchForComplianceEvidence(question, policyText, policyInfo) {
        // Truncate policy text to manageable size with smart truncation
        const smartTruncatedText = this.smartTruncatePolicyText(policyText, question.keywords);
        
        const prompt = `You are a compliance auditor. Given a specific audit question and a policy document, determine if the policy provides evidence to answer the question with a definitive YES or NO.

AUDIT QUESTION: "${question.text}"

POLICY DOCUMENT: ${policyInfo.pdf_name}
CONTENT: ${smartTruncatedText}

Analyze the policy document and respond with ONLY valid JSON in this format:

{
  "hasAnswer": true/false,
  "confidence": "high/medium/low",
  "answer": "yes/no/partial",
  "evidence": "Exact text from the document that provides the evidence",
  "pageReference": "Page number or section reference if available",
  "explanation": "Brief explanation of why this answers YES or NO to the question"
}

Guidelines:
- hasAnswer: true ONLY if the policy directly and clearly addresses the specific question
- answer: "yes" if the requirement IS met/stated, "no" if it is NOT met/contradicted, "partial" if partially addressed
- evidence: Must be the EXACT text from the document (verbatim quote), not paraphrased
- Keep evidence focused and under 500 characters - include the most relevant sentence(s)
- confidence: "high" only if evidence directly answers the question, "medium" if related but not exact, "low" if tangential
- explanation: Brief reasoning for the YES/NO determination
- Only include pageReference if explicitly mentioned in the text

IMPORTANT: Only return hasAnswer: true if you find definitive evidence that directly answers the audit question.`;

        try {
            const result = await this.queuedGeminiRequest(prompt, 'policy_analysis');
            const analysis = this.parseJSONResponse(result, false);
            
            if (analysis.hasAnswer) {
                return {
                    docName: policyInfo.pdf_name,
                    subfolder: policyInfo.subfolder,
                    answer: analysis.answer,
                    evidence: analysis.evidence,
                    pageReference: analysis.pageReference,
                    confidence: analysis.confidence,
                    explanation: analysis.explanation,
                    score: policyInfo.score
                };
            }
            
            return null;
        } catch (error) {
            console.error(`Error searching policy ${policyInfo.pdf_name}:`, error);
            throw new ApiError(500, `Failed to analyze policy: ${error.message}`);
        }
    }

    smartTruncatePolicyText(text, keywords) {
        const maxLength = 18000; // Reduced from 20000 to leave room for prompt
        
        if (text.length <= maxLength) {
            return text;
        }

        // Try to find the most relevant sections based on keywords
        const keywordPositions = [];
        keywords.forEach(keyword => {
            const positions = this.findKeywordPositions(text.toLowerCase(), keyword.toLowerCase());
            keywordPositions.push(...positions);
        });

        if (keywordPositions.length > 0) {
            // Sort positions and extract relevant sections
            keywordPositions.sort((a, b) => a - b);
            const relevantSections = [];
            
            keywordPositions.forEach(pos => {
                const start = Math.max(0, pos - 500);
                const end = Math.min(text.length, pos + 1500);
                relevantSections.push(text.substring(start, end));
            });

            const combinedText = relevantSections.join('\n...\n');
            if (combinedText.length <= maxLength) {
                return combinedText;
            }
        }

        // Fallback to taking first portion of text
        return text.substring(0, maxLength) + '...[truncated]';
    }

    findKeywordPositions(text, keyword) {
        const positions = [];
        let index = text.indexOf(keyword);
        while (index !== -1) {
            positions.push(index);
            index = text.indexOf(keyword, index + 1);
        }
        return positions;
    }

    async queuedGeminiRequest(prompt, requestType) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                prompt,
                requestType,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processingQueue || this.requestQueue.length === 0 || this.activeRequests >= this.maxConcurrentRequests) {
            return;
        }

        this.processingQueue = true;

        while (this.requestQueue.length > 0 && this.activeRequests < this.maxConcurrentRequests) {
            const request = this.requestQueue.shift();
            this.activeRequests++;
            
            this.executeRequest(request).finally(() => {
                this.activeRequests--;
            });
        }

        this.processingQueue = false;
    }

    async executeRequest(request) {
        const startTime = Date.now();
        
        try {
            const result = await this.makeGeminiRequest(request.prompt);
            const endTime = Date.now();
            
            // Track request performance for adaptive delay
            this.requestHistory.push({
                type: request.requestType,
                duration: endTime - startTime,
                timestamp: endTime,
                success: true
            });
            
            this.adjustAdaptiveDelay();
            request.resolve(result);
            
        } catch (error) {
            const endTime = Date.now();
            this.requestHistory.push({
                type: request.requestType,
                duration: endTime - startTime,
                timestamp: endTime,
                success: false,
                error: error.message
            });
            
            this.adjustAdaptiveDelay();
            request.reject(error);
        }

        // Process next items in queue
        setTimeout(() => this.processQueue(), 100);
    }

    adjustAdaptiveDelay() {
        // Keep only recent history (last 10 requests)
        this.requestHistory = this.requestHistory.slice(-10);
        
        const recentFailures = this.requestHistory.filter(h => !h.success).length;
        const avgDuration = this.requestHistory.reduce((sum, h) => sum + h.duration, 0) / this.requestHistory.length;
        
        // Increase delay if there are failures or slow responses
        if (recentFailures > 2) {
            this.adaptiveDelay = Math.min(this.adaptiveDelay * 1.5, 5000);
        } else if (avgDuration > 8000) {
            this.adaptiveDelay = Math.min(this.adaptiveDelay * 1.2, 3000);
        } else if (recentFailures === 0 && avgDuration < 3000) {
            this.adaptiveDelay = Math.max(this.adaptiveDelay * 0.9, 500);
        }
        
        console.log(`Adaptive delay adjusted to ${this.adaptiveDelay}ms (failures: ${recentFailures}, avg duration: ${Math.round(avgDuration)}ms)`);
    }

    async makeGeminiRequest(prompt, retryCount = 0) {
        try {
            const model = getGeminiModel();
            const result = await model.generateContent(prompt);
            
            if (!result || !result.response) {
                throw new Error('No response received from Gemini API');
            }
            
            return result.response.text();
        } catch (error) {
            if (retryCount < this.maxRetries) {
                const delay = this.baseDelay * Math.pow(2, retryCount);
                console.log(`Retrying Gemini request in ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries})`);
                
                await this.sleep(delay);
                return this.makeGeminiRequest(prompt, retryCount + 1);
            }
            
            throw new ApiError(500, `Gemini API error after ${this.maxRetries} retries: ${error.message}`);
        }
    }

    // ... (rest of the parsing methods remain the same as before)
    parseJSONResponse(response, expectQuestionsArray = false) {
        try {
            let cleanedResponse = response.trim();
            
            if (cleanedResponse.startsWith('```json')) {
                cleanedResponse = cleanedResponse.slice(7);
                if (cleanedResponse.endsWith('```')) {
                    cleanedResponse = cleanedResponse.slice(0, -3);
                }
            } else if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.slice(3);
                if (cleanedResponse.endsWith('```')) {
                    cleanedResponse = cleanedResponse.slice(0, -3);
                }
            }
            
            cleanedResponse = cleanedResponse.trim();
            
            try {
                const parsed = JSON.parse(cleanedResponse);
                return this.validateParsedResponse(parsed, expectQuestionsArray);
            } catch (initialError) {
                console.log('Initial JSON parse failed, attempting repairs...');
            }
            
            if (expectQuestionsArray) {
                console.log('Response appears truncated, attempting to fix...');
                const repairedJson = this.findLastCompleteQuestion(cleanedResponse);
                if (repairedJson) {
                    const parsed = JSON.parse(repairedJson);
                    return this.validateParsedResponse(parsed, expectQuestionsArray);
                } else {
                    throw new Error('Response is truncated and cannot be repaired');
                }
            }
            
            if (!cleanedResponse.endsWith('}')) {
                let openBraces = 0;
                for (let i = 0; i < cleanedResponse.length; i++) {
                    if (cleanedResponse[i] === '{') openBraces++;
                    if (cleanedResponse[i] === '}') openBraces--;
                }
                
                cleanedResponse += '}'.repeat(openBraces);
                
                try {
                    const parsed = JSON.parse(cleanedResponse);
                    return this.validateParsedResponse(parsed, expectQuestionsArray);
                } catch (repairError) {
                    throw new Error('Failed to repair malformed JSON');
                }
            }
            
            throw new Error('Unable to parse or repair JSON response');
            
        } catch (error) {
            console.error('JSON parsing error:', error);
            console.error('Raw response length:', response.length);
            console.error('Raw response (first 500 chars):', response.substring(0, 500));
            console.error('Raw response (last 500 chars):', response.substring(Math.max(0, response.length - 500)));
            throw new ApiError(500, 'Failed to parse AI response as JSON');
        }
    }
    
    validateParsedResponse(parsed, expectQuestionsArray) {
        if (expectQuestionsArray) {
            if (!parsed.questions || !Array.isArray(parsed.questions)) {
                throw new Error('Invalid JSON structure: missing or invalid questions array');
            }
            
            for (let i = 0; i < parsed.questions.length; i++) {
                const q = parsed.questions[i];
                if (!q.id || !q.text || !q.category || !q.keywords || !q.description) {
                    console.log(`Question ${i + 1} missing required fields, removing...`);
                    parsed.questions.splice(i, 1);
                    i--;
                }
            }
            
            console.log(`Validated ${parsed.questions.length} questions`);
        } else {
            const requiredFields = ['hasAnswer', 'confidence'];
            const missingFields = requiredFields.filter(field => !(field in parsed));
            if (missingFields.length > 0) {
                throw new Error(`Invalid JSON structure: missing required fields: ${missingFields.join(', ')}`);
            }
        }
        
        return parsed;
    }

    findLastCompleteQuestion(jsonString) {
        try {
            let cleanJson = jsonString;
            if (cleanJson.startsWith('```json')) {
                cleanJson = cleanJson.slice(7);
            }
            if (cleanJson.startsWith('```')) {
                cleanJson = cleanJson.slice(3);
            }
            
            const questionPattern = /{[\s\S]*?"id":\s*\d+[\s\S]*?"text":\s*"[^"]*"[\s\S]*?"category":\s*"[^"]*"[\s\S]*?"keywords":\s*\[[^\]]*\][\s\S]*?"description":\s*"[^"]*"[\s\S]*?"requiresEvidence":\s*(true|false)[\s\S]*?}/g;
            
            const matches = [];
            let match;
            
            while ((match = questionPattern.exec(cleanJson)) !== null) {
                const questionObj = match[0];
                
                try {
                    const testObj = JSON.parse(questionObj);
                    if (testObj.id && testObj.text && testObj.category && testObj.keywords && testObj.description) {
                        matches.push(questionObj);
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (matches.length === 0) {
                console.log('No complete question objects found, trying alternative approach...');
                return this.tryAlternativeRepair(cleanJson);
            }
            
            const repairedJson = `{"questions":[${matches.join(',')}]}`;
            
            const testParsed = JSON.parse(repairedJson);
            console.log(`Repaired JSON with ${matches.length} complete questions`);
            return repairedJson;
            
        } catch (error) {
            console.error('Failed to repair JSON with primary method:', error);
            return this.tryAlternativeRepair(jsonString);
        }
    }
    
    tryAlternativeRepair(jsonString) {
        try {
            const questionsStart = jsonString.indexOf('"questions": [');
            if (questionsStart === -1) {
                return null;
            }
            
            let questionsSection = jsonString.substring(questionsStart + 13);
            
            const questions = [];
            let braceCount = 0;
            let currentQuestion = '';
            let inString = false;
            let escapeNext = false;
            
            for (let i = 0; i < questionsSection.length; i++) {
                const char = questionsSection[i];
                
                if (escapeNext) {
                    escapeNext = false;
                    currentQuestion += char;
                    continue;
                }
                
                if (char === '\\') {
                    escapeNext = true;
                    currentQuestion += char;
                    continue;
                }
                
                if (char === '"' && !escapeNext) {
                    inString = !inString;
                }
                
                if (!inString) {
                    if (char === '{') {
                        if (braceCount === 0) {
                            currentQuestion = char;
                        } else {
                            currentQuestion += char;
                        }
                        braceCount++;
                    } else if (char === '}') {
                        currentQuestion += char;
                        braceCount--;
                        
                        if (braceCount === 0) {
                            try {
                                const testObj = JSON.parse(currentQuestion);
                                if (testObj.id && testObj.text) {
                                    questions.push(currentQuestion);
                                }
                            } catch (e) {
                                // Skip invalid question
                            }
                            currentQuestion = '';
                        }
                    } else if (braceCount > 0) {
                        currentQuestion += char;
                    }
                } else {
                    currentQuestion += char;
                }
            }
            
            if (questions.length > 0) {
                const repairedJson = `{"questions":[${questions.join(',')}]}`;
                JSON.parse(repairedJson);
                console.log(`Alternative repair successful with ${questions.length} questions`);
                return repairedJson;
            }
            
            return null;
        } catch (error) {
            console.error('Alternative repair also failed:', error);
            return null;
        }
    }

    splitTextIntoChunks(text, chunkSize) {
        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + chunkSize;
            
            if (end < text.length) {
                const questionBreak = text.lastIndexOf('?', end);
                if (questionBreak > start + chunkSize * 0.7) {
                    end = questionBreak + 1;
                }
            }
            
            chunks.push(text.substring(start, end));
            start = end;
        }

        return chunks;
    }

    createBatches(array, batchSize) {
        const batches = [];
        for (let i = 0; i < array.length; i += batchSize) {
            batches.push(array.slice(i, i + batchSize));
        }
        return batches;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getQueueStats() {
        return {
            queueLength: this.requestQueue.length,
            activeRequests: this.activeRequests,
            maxConcurrent: this.maxConcurrentRequests,
            adaptiveDelay: this.adaptiveDelay,
            recentHistory: this.requestHistory.slice(-5)
        };
    }

    adjustConcurrencyLimits(maxConcurrent) {
        this.maxConcurrentRequests = Math.max(1, Math.min(maxConcurrent, 5));
        console.log(`Concurrency limit adjusted to ${this.maxConcurrentRequests}`);
    }
}

const optimizedGeminiService = new OptimizedGeminiService();

export default optimizedGeminiService;