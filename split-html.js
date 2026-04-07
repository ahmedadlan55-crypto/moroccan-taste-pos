const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join('c:/Users/ahmed/Downloads/moroccan-taste-pos/public', 'index.html');
const viewsDir = path.join('c:/Users/ahmed/Downloads/moroccan-taste-pos', 'views');
const appContentPath = path.join(viewsDir, 'app-content.html');

let html = fs.readFileSync(indexHtmlPath, 'utf8');

const splitStartMarker = '<!-- 2. POS SCREEN (Cashier) -->';
const splitEndMarker = '<!-- Include Custom JavaScript'; // It is "<!-- Include Custom JavaScript — erp.js loads on-demand via loadScript() in app.js -->"

const startIndex = html.indexOf(splitStartMarker);
const endIndex = html.indexOf(splitEndMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Markers not found!');
    process.exit(1);
}

const loginHtmlStart = html.substring(0, startIndex);
let extractedContent = html.substring(startIndex, endIndex);
let loginHtmlEnd = html.substring(endIndex);

// Add a placeholder where the content was extracted
const finalIndexHtml = loginHtmlStart + '\n  <!-- TEMPLATE_INJECTION_POINT -->\n  ' + loginHtmlEnd;

if (!fs.existsSync(viewsDir)) {
    fs.mkdirSync(viewsDir, { recursive: true });
}

fs.writeFileSync(appContentPath, extractedContent, 'utf8');
fs.writeFileSync(indexHtmlPath, finalIndexHtml, 'utf8');

console.log('HTML file successfully split.');
