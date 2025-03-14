const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const debug = require('debug')('docucheat:processor');

const AI_API_URL = 'https://ai.hackclub.com/chat/completions';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second delay between retries

class DocumentProcessor {
  constructor(socket) {
    this.socket = socket;
    this.tableOfContents = null;
    this.courseInfo = null;
    this.examQuestions = [];
    // Initialize statistics
    this.stats = {
      totalPages: 0,
      examPages: 0,
      tocEntries: 0,
      totalQuestions: 0,
      validQuestions: 0,
      invalidQuestions: 0,
      processedQuestions: 0,
      failedQuestions: 0
    };
  }

  emitStats() {
    this.socket.emit('stats', this.stats);
  }

  async processDocument(data) {
    try {
      debug('Starting document processing with file:', data.filePath);
      this.socket.emit('status', { message: 'Converting PDF to text...', progress: 10 });
      this.socket.emit('log', { type: 'info', message: 'Starting document processing' });
      
      const pdfText = await this.convertPdfToText(data.filePath);
      this.stats.totalPages = this.pdfData.numpages;
      this.emitStats();
      debug('PDF converted to text');
      
      this.socket.emit('status', { message: 'Extracting document sections...', progress: 30 });
      await this.extractDocumentSections(pdfText);
      
      this.socket.emit('status', { message: 'Processing exam questions...', progress: 50 });
      await this.extractExamQuestions();
      
      this.socket.emit('status', { message: 'Analyzing questions with AI...', progress: 70 });
      await this.processQuestionsWithAI();
      
      this.socket.emit('status', { message: 'Processing complete', progress: 100 });
      this.emitStats(); // Final stats update
      debug('Document processing completed');
    } catch (error) {
      debug('Error in document processing:', error);
      this.socket.emit('log', { type: 'error', message: `Document processing error: ${error.message}` });
      this.socket.emit('status', { message: 'Error processing document', progress: 0 });
      this.emitStats(); // Emit stats even on error
      throw error;
    }
  }

  async convertPdfToText(filePath) {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      this.filePath = filePath; // Store filePath for later use
      this.pdfData = pdfData; // Store pdfData for later use
      
      // Save text version
      const textFilePath = filePath.replace('.pdf', '.txt');
      fs.writeFileSync(textFilePath, pdfData.text);
      this.textFilePath = textFilePath;
      this.socket.emit('text-file-ready', { filename: path.basename(textFilePath) });
      this.socket.emit('text-content', pdfData.text);
      
      return pdfData.text;
    } catch (error) {
      debug('Error converting PDF to text:', error);
      throw error;
    }
  }

  async extractDocumentSections(text) {
    debug('Extracting document sections');
    
    // First attempt: Try to find exam sections using page markers
    const pages = text.split(/\f/);
    const examPages = [];
    let examText = '';
    
    pages.forEach((page, index) => {
      // More lenient check for exam pages
      if (page.includes('Final Exam Copy') || 
          page.match(/\d{1,3}\s*\.\s*[^\n]+(?:\n\s*[A-Z]\s*\.\s*[^\n]+){2,}/) // Question pattern
      ) {
        examPages.push(index + 1);
        examText += page + '\n';
        debug(`Found exam content on page ${index + 1}`);
      }
    });
    
    // Fallback: If no exam pages found, try to extract questions directly
    if (examPages.length === 0) {
      debug('No exam pages found with markers, trying direct question extraction');
      const questionPattern = /(?:^|\n)\s*(\d{1,3})\s*\.\s*([^\n]+(?:\n(?!\s*\d{1,3}\s*\.|\s*[A-Z]\s*\.).)*)((?:\n\s*[A-Z]\s*\.\s*[^\n]+)*)/gm;
      const matches = Array.from(text.matchAll(questionPattern));
      
      if (matches.length > 0) {
        debug(`Found ${matches.length} questions through direct pattern matching`);
        examText = text; // Use the entire text since we found questions
        examPages.push(1); // Mark the first page as an exam page
      } else {
        throw new Error('Final Exam section not found - no exam markers or question patterns detected');
      }
    }
    
    this.stats.examPages = examPages.length;
    debug(`Found exam pages: ${examPages.join(', ')}`);
    this.examPages = examPages;
    this.examText = examText;
    
    // Extract other sections
    this.tableOfContents = pages.find(page => page.includes('Table of Contents'));
    if (this.tableOfContents) {
      this.stats.tocEntries = this.tableOfContents.split('\n')
        .filter(line => line.match(/^\s*\d+\.\s+/)).length;
    }
    this.courseInfo = pages.find(page => page.includes('Course Information'));
    
    this.emitStats();
    debug('Document sections extracted');
  }

  async extractExamQuestions() {
    debug('Extracting exam questions');
    if (!this.examText) {
      const error = new Error('Exam text not found. Document sections may not have been properly extracted.');
      this.socket.emit('log', { type: 'error', message: error.message });
      throw error;
    }

    // Updated question pattern to better match the exam format
    const questionPattern = /(?:^|\n)\s*(\d{1,3})\s*\.\s*([^\n]+(?:\n(?!\s*\d{1,3}\s*\.|\s*[A-Z]\s*\.).*)*)((?:\n\s*[A-Z]\s*\.\s*[^\n]+){2,})/gm;
    
    // Split exam text into pages to ensure we capture all questions
    const pages = this.examText.split('Final Exam Copy');
    let allMatches = [];
    
    pages.forEach(page => {
      const pageMatches = Array.from(page.matchAll(questionPattern));
      allMatches = allMatches.concat(pageMatches);
    });
    
    this.stats.totalQuestions = allMatches.length;
    if (!allMatches.length) {
      const error = new Error('No questions found in exam text');
      this.socket.emit('log', { type: 'error', message: error.message });
      throw error;
    }

    debug(`Found ${allMatches.length} potential questions`);
    
    let validQuestions = [];
    allMatches.forEach((match, index) => {
      try {
        const [fullMatch, number, questionText, choicesText] = match;
        if (!questionText || !number || !choicesText) {
          this.stats.invalidQuestions++;
          this.socket.emit('log', { 
            type: 'error', 
            message: `Invalid question format for question ${index + 1}: Missing number, text or choices`
          });
          return;
        }

        const questionData = {
          number: parseInt(number),
          text: questionText.trim().replace(/\s+/g, ' '),
          choices: []
        };

        // Extract choices with improved pattern that handles multi-line choices
        const choicePattern = /\n\s*([A-Z])\s*\.\s*([^\n]+(?:\n(?!\s*[A-Z]\s*\.).*)*)/g;
        const choiceMatches = Array.from(choicesText.matchAll(choicePattern));
        if (choiceMatches.length > 0) {
          questionData.choices = choiceMatches.map(([_, letter, choiceText]) => (
            `${letter}. ${choiceText.trim().replace(/\s+/g, ' ')}`
          ));
        }

        // Validate question has at least 2 choices
        if (questionData.choices.length >= 2) {
          this.stats.validQuestions++;
          // Format question in the desired format
          const formattedQuestion = `${questionData.number}. ${questionData.text}\n${questionData.choices.join('\n')}\n\n----------\n\n`;
          validQuestions.push(formattedQuestion);
          this.socket.emit('log', { 
            type: 'info', 
            message: `Extracted question ${number} with ${questionData.choices.length} choices`,
            data: formattedQuestion
          });
        } else {
          this.stats.invalidQuestions++;
          this.socket.emit('log', { 
            type: 'error', 
            message: `Insufficient choices found for question ${number}`
          });
        }
      } catch (error) {
        this.stats.invalidQuestions++;
        this.socket.emit('log', { 
          type: 'error', 
          message: `Error parsing question ${index + 1}: ${error.message}`
        });
      }
    });
    
    this.examQuestions = validQuestions;
    this.emitStats();
    debug(`${this.examQuestions.length} questions extracted`);
  }

  async processQuestionsWithAI() {
    debug('Processing questions with AI');
    if (!this.examQuestions || this.examQuestions.length === 0) {
      throw new Error('No questions to process');
    }

    // Emit the raw questions for debugging
    const questionsText = this.examQuestions.map(q => q.text).join('\n\n');
    this.socket.emit('text-file-ready', { filename: 'extracted_questions.txt' });
    this.socket.emit('text-content', questionsText);

    for (let i = 0; i < this.examQuestions.length; i += 10) {
      const batch = this.examQuestions.slice(i, i + 10);
      try {
        for (const { number, text, choices } of batch) {
          const relevantPages = await this.getRelevantPages({ text, choices });
          const pageContents = await this.getPageContents(relevantPages);

          let aiResponse = null;
          let retryCount = 0;
          const maxRetries = 1;

          while (retryCount <= maxRetries) {
            try {
              const answerResponse = await fetch(AI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messages: [{
                    role: 'user',
                    content: `Answer this multiple choice question. Format your response as:\nAnswer: [letter]\n\nReason: [explanation]\n\nQuestion:\n${text}\n${choices.join('\n')}\n\nRelevant content:\n${pageContents}`
                  }]
                })
              });

              const answerData = await answerResponse.json();
              if (!answerData.choices?.[0]?.message?.content) {
                throw new Error('Invalid AI response format');
              }

              aiResponse = answerData.choices[0].message.content;
              
              // Check if the response indicates an invalid question
              if (aiResponse.includes('Invalid Question Provided')) {
                debug(`Question ${number} marked as invalid by AI`);
                this.socket.emit('question-error', {
                  question: `${number}. ${text}\n${choices.join('\n')}`,
                  error: 'Invalid question format',
                  rawResponse: aiResponse,
                  aiResponse: answerData.choices[0].message // Include full AI response
                });
                break;
              }

              // Emit both processed question and raw AI response for debugging
              this.socket.emit('question-processed', {
                question: `${number}. ${text}\n${choices.join('\n')}`,
                answer: aiResponse,
                pageNumbers: relevantPages,
                rawResponse: answerData.choices[0].message, // Include full AI response
                aiResponseData: answerData // Include complete AI response data
              });

              this.stats.processedQuestions++;
              this.emitStats();
              break;
            } catch (error) {
              retryCount++;
              if (retryCount > maxRetries) {
                throw error;
              }
              debug(`Retrying question ${number} after error: ${error.message}`);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            }
          }
        }
      } catch (error) {
        debug(`Error processing batch starting at question ${i + 1}:`, error);
        this.stats.failedQuestions += batch.length;
        this.socket.emit('log', {
          type: 'error',
          message: `Failed to process questions ${i + 1}-${Math.min(i + 10, this.examQuestions.length)}: ${error.message}`
        });
      }
    }
  }
  
  // Helper method to parse AI response into individual question responses
  parseAIResponse(aiResponse, questions) {
    const results = [];
    
    // Extract question numbers from the batch
    const questionNumbers = questions.map(q => {
      const match = q.match(/^(\d+)\. /);
      return match ? match[1] : null;
    }).filter(Boolean);
    
    // For each question number, try to find its answer in the AI response
    questionNumbers.forEach(qNum => {
      // Find the corresponding question text
      const questionText = questions.find(q => q.startsWith(`${qNum}. `));
      if (!questionText) return;
      
      // Look for the answer in the AI response
      const answerRegex = new RegExp(`Question\s*${qNum}[^]*?Answer:\s*([A-Z])`, 'i');
      const answerMatch = aiResponse.match(answerRegex);
      
      if (answerMatch) {
        results.push({
          question: questionText,
          answer: `The correct answer is ${answerMatch[1]}.`,
          explanation: ''
        });
      } else {
        // If no specific answer found, use a generic response
        results.push({
          question: questionText,
          answer: "The AI couldn't determine a specific answer for this question.",
          explanation: ''
        });
      }
    });
    
    return results;
  }

  async getPageContents(pageNumbers) {
    if (!pageNumbers || pageNumbers.length === 0) {
      return '';
    }

    try {
      const dataBuffer = fs.readFileSync(this.filePath);
      const pdfData = await pdfParse(dataBuffer);
      const pages = pdfData.text.split(/\f/);
      
      return pageNumbers
        .map(num => {
          const pageIndex = parseInt(num) - 1;
          return pageIndex >= 0 && pageIndex < pages.length ? pages[pageIndex].trim() : '';
        })
        .filter(Boolean)
        .join('\n\n');
    } catch (error) {
      debug('Error getting page contents:', error);
      return '';
    }
  }

  async getRelevantPages(question) {
    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `Given this question and table of contents, list up to 10 most relevant page numbers separated by commas:\n\nTable of Contents:\n${this.tableOfContents}\n\nQuestion:\n${question.text}\n\nRespond only with page numbers like: "Pages: 1,2,3,4,5"`
        }]
      })
    });

    const data = await response.json();
    const pages = data.choices[0].message.content.match(/\d+/g) || [];
    return pages.slice(0, 10);
  }

  async getAnswerFromAI(question, pageContents) {
    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Given this question, its choices, and the relevant content, provide the correct answer:\n\nQuestion: ${question.text}\n\nChoices:\n${question.choices.join('\n')}\n\nRelevant Content:\n${pageContents}\n\nRespond only in this format:\nAnswer: <letter> - <answer text>`
          }]
        })
      });

      const data = await response.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        const error = new Error(`Invalid AI response format: ${JSON.stringify(data)}`);
        error.aiResponse = JSON.stringify(data);
        throw error;
      }
      return data.choices[0].message.content;
    } catch (error) {
      debug('AI processing error:', error);
      const enhancedError = new Error(`AI processing failed: ${error.message}`);
      enhancedError.aiResponse = error.aiResponse || error.response || JSON.stringify(error);
      throw enhancedError;
    }
  }
}

module.exports = {
  processDocument: async (data, socket) => {
    const processor = new DocumentProcessor(socket);
    await processor.processDocument(data);
  }
};