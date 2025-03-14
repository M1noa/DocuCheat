const socket = io();

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const progressContainer = document.querySelector('.progress-container');
const progressFill = document.querySelector('.progress-fill');
const statusText = document.querySelector('.status-text');
const resultsContainer = document.querySelector('.results-container');
const questionsList = document.querySelector('.questions-list');
const statsContainer = document.querySelector('.stats-container');

// Stats elements
const statsElements = {
    totalPages: document.getElementById('totalPages'),
    examPages: document.getElementById('examPages'),
    tocEntries: document.getElementById('tocEntries'),
    totalQuestions: document.getElementById('totalQuestions'),
    processedQuestions: document.getElementById('processedQuestions'),
    failedQuestions: document.getElementById('failedQuestions')
};

// Update stats function
function updateStats(stats) {
    for (const [key, element] of Object.entries(statsElements)) {
        if (stats[key] !== undefined) {
            element.textContent = stats[key];
        }
    }
}

// Socket event for stats
socket.on('stats', (stats) => {
    console.log('Stats update:', stats);
    updateStats(stats);
});

// Drag and drop handling
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

// File handling
async function handleFile(file) {
  if (file.type !== 'application/pdf') {
    showError('Please upload a PDF file');
    return;
  }

  if (file.size > 100 * 1024 * 1024) {
    showError('File size must be less than 100MB');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    const data = await response.json();
    if (data.success) {
      showProgress();
      isProcessing = true;
      socket.emit('process-document', { filePath: file.name });
    }
  } catch (error) {
    showError('Error uploading file');
    console.error('Upload error:', error);
  }
}

let hasError = false;
let isProcessing = false;

// WebSocket event handling
socket.on('status', ({ message, progress }) => {
  if (hasError) return;
  console.log('Status update:', { message, progress });
  updateProgress(progress, message);
});

socket.on('disconnect', () => {
  if (isProcessing) {
    hasError = true;
    showPermanentError('Connection lost. Please refresh the page to start over.');
  }
});

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
  hasError = true;
  showPermanentError('Connection error: ' + error.message + '. Please refresh the page to start over.');
});

// Add permanent error display function
function showPermanentError(message) {
  console.error('Permanent error:', message);
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error permanent';
  errorDiv.textContent = message;
  progressContainer.insertAdjacentElement('afterend', errorDiv);
  
  // Hide progress and disable dropzone
  progressContainer.style.display = 'none';
  dropZone.style.pointerEvents = 'none';
  dropZone.style.opacity = '0.5';
}

// Add page unload handler
window.addEventListener('beforeunload', () => {
  if (isProcessing) {
    socket.emit('cancel-processing');
    socket.disconnect();
  }
});

socket.on('log', ({ type, message, data }) => {
  console.log(`[${type}] ${message}`, data || '');
  if (type === 'error') {
    showError(message);
  }
});

socket.on('text-file-ready', (data) => {
  const downloadButton = document.createElement('button');
  downloadButton.className = 'download-text-btn';
  downloadButton.innerHTML = '<img src="download-icon.svg" alt="Download" />';
  
  // Store text content in memory when received
  socket.once('text-content', (textContent) => {
    const blob = new Blob([textContent], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    
    downloadButton.onclick = () => {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  });
  
  document.body.appendChild(downloadButton);
});

socket.on('formatted-questions-ready', (data) => {
  const downloadButton = document.createElement('button');
  downloadButton.className = 'download-text-btn formatted-questions';
  downloadButton.innerHTML = '<img src="download-icon.svg" alt="Download Formatted" />';
  
  const blob = new Blob([data.content], { type: 'text/plain' });
  const objectUrl = URL.createObjectURL(blob);
  
  downloadButton.onclick = () => {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = data.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  document.body.appendChild(downloadButton);
});

socket.on('question-processed', ({ question, answer, pageNumbers, rawResponse, aiResponseData, aiResponse }) => {
  console.log('Question processed:', { question, answer, pageNumbers });
  console.log('AI Response Data:', aiResponseData);
  console.log('Full AI Response:', aiResponse);
  addQuestionResult(question, answer, pageNumbers, rawResponse, aiResponseData);
  
  // Format questions for clean text download
  const formattedContent = processedQuestions.map(q => {
    return `Question ${q.question.number}\n${q.question.text}\n\nChoices:\n${q.question.choices.join('\n')}\n\nAnswer: ${q.answer}\n\n-------------------\n`;
  }).join('\n');
  
  // Emit formatted questions ready event
  socket.emit('formatted-questions-ready', {
    content: formattedContent,
    filename: 'formatted_questions.txt'
  });
});

socket.on('question-error', ({ question, error, rawResponse, aiResponse, statusCode, headers }) => {
  console.error('Question processing error:', { question, error });
  console.error('Status Code:', statusCode);
  console.error('Response Headers:', headers);
  console.error('Raw Response:', rawResponse);
  console.error('Full AI Response:', aiResponse);
  
  let errorMessage = `Error processing question: ${error}`;
  if (statusCode === 401) {
    errorMessage += '\nAPI authentication failed. Please check your API key.';
  } else if (statusCode === 429) {
    errorMessage += '\nAPI rate limit exceeded. The system will automatically retry.';
  }
  
  addQuestionResult(question, errorMessage, [], rawResponse, {
    error: true,
    statusCode,
    headers,
    message: error
  });
});

socket.on('error', ({ message }) => {
  console.error('Socket error:', message);
  showError(message);
});

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
  showError('Connection error: ' + error.message);
});

// UI updates
function showProgress() {
  console.log('Showing progress UI');
  dropZone.style.display = 'none';
  progressContainer.style.display = 'block';
  resultsContainer.style.display = 'block';
  statsContainer.style.display = 'block'; // Ensure stats container is visible
  
  // Reset the questions list
  questionsList.innerHTML = '';
}

let processedQuestions = [];

function addQuestionResult(question, answer, pageNumbers, rawResponse, aiResponseData) {
  const questionDiv = document.createElement('div');
  questionDiv.className = 'question-result';
  questionDiv.innerHTML = `
    <h3>Question ${question.number}</h3>
    <p class="question-text">${question.text}</p>
    <div class="choices">${question.choices.map(c => `<div class="choice">${c}</div>`).join('')}</div>
    <p class="answer"><strong>Answer:</strong> ${answer}</p>
  `;
  questionsList.appendChild(questionDiv);
  processedQuestions.push({ question, answer, pageNumbers });
}

// Remove printQuestions function since it's no longer needed
socket.on('text-file-ready', (data) => {
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'button-container';
  
  const downloadButton = document.createElement('button');
  downloadButton.className = 'download-text-btn';
  downloadButton.innerHTML = '<img src="download-icon.svg" alt="Download" />';
  
  // Store text content in memory when received
  socket.once('text-content', (textContent) => {
    const blob = new Blob([textContent], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    
    downloadButton.onclick = () => {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  });
  
  buttonContainer.appendChild(downloadButton);
  document.body.appendChild(buttonContainer);
});

// Remove printQuestions function since it's no longer needed
function printQuestions() {
  const questionsPerPage = 69;
  const printWindow = window.open('', '_blank');
  
  let printContent = `
    <html>
    <head>
      <title>Exam Questions and Answers</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .question { margin-bottom: 20px; page-break-inside: avoid; }
        .page-break { page-break-after: always; }
        @media print {
          body { padding: 0; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
  `;
  
  for (let i = 0; i < processedQuestions.length; i++) {
    const q = processedQuestions[i];
    printContent += `
      <div class="question">
        <h3>Question ${q.question.number}</h3>
        <p>${q.question.text}</p>
        <div class="choices">
          ${q.question.choices.map(c => `<div>${c}</div>`).join('')}
        </div>
        <p><strong>Answer:</strong> ${q.answer}</p>
      </div>
    `;
    
    if ((i + 1) % questionsPerPage === 0 && i < processedQuestions.length - 1) {
      printContent += '<div class="page-break"></div>';
    }
  }
  
  printContent += `
      <button class="no-print" onclick="window.print()">Print</button>
    </body>
    </html>
  `;
  
  printWindow.document.write(printContent);
  printWindow.document.close();
}

// Update progress display
function updateProgress(progress, message) {
  if (progressFill && statusText) {
    progressFill.style.width = `${progress}%`;
    statusText.textContent = message;
  }
}

const searchInput = document.getElementById('searchInput');

searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase();
    const questions = questionsList.getElementsByClassName('question-item');

    Array.from(questions).forEach(question => {
        const text = question.textContent.toLowerCase();
        question.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
});

function addQuestionResult(question, answer, pageNumbers, rawResponse, aiResponseData) {
    const questionItem = document.createElement('div');
    questionItem.className = 'question-item';

    // Extract question number for sorting
    const questionNumber = question.match(/^(\d+)\./)?.[1] || '0';
    questionItem.dataset.questionNumber = questionNumber;

    if (answer?.includes('Error')) {
        questionItem.innerHTML = `
            <div class="question">${question.trim()}</div>
            <div class="error">${answer}</div>
        `;
    } else {
        const answerParts = answer ? answer.split('\nReason:') : ['', ''];
        const answerPart = answerParts[0] || '';
        const reasonPart = answerParts[1] || '';
        
        questionItem.innerHTML = `
            <div class="question">${question.trim().replace(/[-]{4,}/g, '---')}</div>
            <div class="answer">${answerPart.trim()}</div>
            ${reasonPart ? `<div class="reason">${reasonPart.trim()}</div>` : ''}
        `;
    }

    // Find the correct position to insert the question
    const existingQuestions = Array.from(questionsList.children);
    const insertIndex = existingQuestions.findIndex(item => 
        parseInt(item.dataset.questionNumber) > parseInt(questionNumber)
    );

    if (insertIndex === -1) {
        questionsList.appendChild(questionItem);
    } else {
        questionsList.insertBefore(questionItem, existingQuestions[insertIndex]);
    }
}

// Add download buttons for text and JSON formats
function addDownloadButtons() {
    const downloadContainer = document.createElement('div');
    downloadContainer.className = 'download-container';
    downloadContainer.style.position = 'fixed';
    downloadContainer.style.bottom = '2rem';
    downloadContainer.style.right = '2rem';
    downloadContainer.style.display = 'flex';
    downloadContainer.style.gap = '1rem';
    document.body.appendChild(downloadContainer);

    // Text download button
    const textButton = document.createElement('button');
    textButton.className = 'download-text-btn';
    textButton.innerHTML = '<img src="download-icon.svg" alt="Download Text" title="Download as Text"/>';
    textButton.title = 'Download exam answers as text format';
    textButton.onclick = downloadAsText;

    // JSON download button
    const jsonButton = document.createElement('button');
    jsonButton.className = 'download-text-btn';
    jsonButton.innerHTML = '<img src="download-icon.svg" alt="Download JSON" title="Download as JSON"/>';
    jsonButton.style.backgroundColor = 'var(--primary-dark)';
    jsonButton.title = 'Download exam answers as JSON format';
    jsonButton.onclick = downloadAsJson;

    downloadContainer.appendChild(textButton);
    downloadContainer.appendChild(jsonButton);
}

function downloadAsText() {
    const questions = Array.from(document.querySelectorAll('.question-item'));
    let content = 'Exam Questions and Answers\n\n';

    questions.forEach(item => {
        const question = item.querySelector('.question').textContent;
        const answer = item.querySelector('.answer')?.textContent || '';
        const reason = item.querySelector('.reason')?.textContent || '';

        content += `${question}\n\n${answer}\n${reason}\n\n`;
    });

    downloadFile(content, 'exam_answers.txt', 'text/plain');
}

function downloadAsJson() {
    const questions = Array.from(document.querySelectorAll('.question-item'));
    const data = questions.map(item => ({
        question: item.querySelector('.question').textContent,
        answer: item.querySelector('.answer')?.textContent || '',
        reason: item.querySelector('.reason')?.textContent || ''
    }));

    downloadFile(JSON.stringify(data, null, 2), 'exam_answers.json', 'application/json');
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Initialize download buttons
addDownloadButtons();

function showError(message) {
  console.error('Error:', message);
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  progressContainer.insertAdjacentElement('afterend', errorDiv);
  setTimeout(() => errorDiv.remove(), 5000);
}

// Color palette for dynamic theming
const colorPalettes = [
  { primary: '#1DA1F2', primaryDark: '#1A91DA' }, // Twitter Blue
  { primary: '#794BC4', primaryDark: '#6B44B8' }, // Twitter Purple
  { primary: '#E0245E', primaryDark: '#C9204F' }, // Twitter Pink
  { primary: '#17BF63', primaryDark: '#15AC59' }, // Twitter Green
  { primary: '#FFAD1F', primaryDark: '#F09C00' }, // Twitter Orange
  { primary: '#9747FF', primaryDark: '#8A3EFF' }, // Bright Purple
  { primary: '#00B5B8', primaryDark: '#009B9E' }, // Teal
  { primary: '#FF6B6B', primaryDark: '#FF5252' }, // Coral
  { primary: '#4ECDC4', primaryDark: '#45B7AE' }, // Mint
  { primary: '#3F51B5', primaryDark: '#303F9F' }, // Indigo
  { primary: '#F7CAC9', primaryDark: '#F0B7B6' }, // Rose Gold
  { primary: '#92A8D1', primaryDark: '#7B8EB8' }, // Serenity Blue
  { primary: '#88B04B', primaryDark: '#7A9D42' }, // Greenery
  { primary: '#955251', primaryDark: '#7A4344' }, // Marsala
  { primary: '#45B7D1', primaryDark: '#3DA1B8' }, // Scuba Blue
  { primary: '#DD4492', primaryDark: '#C93D83' }, // Pink Yarrow
  { primary: '#009B77', primaryDark: '#008566' }, // Viridian
  { primary: '#B565A7', primaryDark: '#9E5894' }, // Radiant Orchid
  { primary: '#DD4124', primaryDark: '#C93A20' }, // Tangerine Tango
  { primary: '#9B2335', primaryDark: '#841E2D' }  // Red Pear
];

// Function to set random color theme
function setRandomColorTheme() {
  const randomPalette = colorPalettes[Math.floor(Math.random() * colorPalettes.length)];
  document.documentElement.style.setProperty('--primary', randomPalette.primary);
  document.documentElement.style.setProperty('--primary-dark', randomPalette.primaryDark);
}

// Set random color theme on page load
window.addEventListener('load', setRandomColorTheme);

// Add header click handler
document.querySelector('.header').addEventListener('click', () => {
  window.location.href = '/';
});