const searchForm = document.getElementById('search-form');
const submitBtn = document.getElementById('submit-btn');
const clearBtn = document.getElementById('clear-btn');
const locationInput = document.getElementById('location');
const businessLineInput = document.getElementById('mainBusinessLine');
const resultsDiv = document.getElementById('results');
const statusText = document.getElementById('status');

clearBtn.addEventListener('click', () => {
  clearLocalCompanies();
  renderResults();
  statusText.textContent = 'Saved companies cleared.';
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault(); // Prevents the browser from refreshing the page

  const location = locationInput.value.trim();
  const businessLine = businessLineInput.value.trim();

  // Disable button while loading
  submitBtn.disabled = true;
  statusText.textContent = 'Fetching data, please wait...';

  try {
    const companies = await fetchCompanies(location, businessLine);
    localStorage.setItem('savedCompanies', JSON.stringify(companies));
    statusText.textContent = `Successfully saved ${companies.length} companies to Local Storage!`;
    renderResults();
  } catch (error) {
    statusText.textContent = `An error occurred while fetching data: ${error.message}`;
    console.error(error);
  } finally {
    submitBtn.disabled = false;
  }
});

async function fetchCompanies(location = '', mainBusinessLine = '') {
  const baseUrl = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';
  let page = 1;
  let allCompanies = [];
  let firstPageRaw = null;

  while (true) {
    // Build query string
    const params = new URLSearchParams({ page });
    if (location) params.append('location', location);
    if (mainBusinessLine) params.append('mainBusinessLine', mainBusinessLine);

    const url = `${baseUrl}?${params.toString()}`;
    console.log(`Fetching page ${page}...`);

    const response = await fetch(url, {
      headers: { 'accept': 'application/json' }
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `PRH API returned ${response.status} ${response.statusText}${details ? `: ${details}` : ''}`
      );
    }

    const data = await response.json();
    if (!Array.isArray(data.companies)) {
      throw new Error('PRH API response did not contain a companies list.');
    }
    const companies = data.companies;

    if (companies.length === 0) break;

    // Detect pagination wrap-around (API looping back to page 1)
    const currentRaw = JSON.stringify(data);
    if (page > 1 && currentRaw === firstPageRaw) {
      console.log('Reached end of pagination.');
      break;
    }
    if (page === 1) firstPageRaw = currentRaw;

    // Clean up fields directly during fetch
    const cleaned = companies.map(c => {
      const fiDesc = c.mainBusinessLine?.descriptions?.find(d => d.languageCode === '1')?.description;
      const mainDesc = c.mainBusinessLine?.descriptions?.[0]?.description;
      const addr = c.addresses?.[0];
      const cityFi = addr?.postOffices?.find(p => p.languageCode === '1')?.city;

      const streetParts = [addr?.street, addr?.buildingNumber, addr?.entrance]
        .filter(Boolean)
        .join(' ');

      return {
        businessId: c.businessId?.value,
        name: c.names?.[0]?.name || null,
        businessLine: fiDesc || mainDesc || null,
        city: cityFi || null,
        street: streetParts || null,
        postCode: addr?.postCode || null
      };
    });

    allCompanies.push(...cleaned);
    page++;
  }

  // Deduplicate by businessId
  const uniqueMap = new Map();
  allCompanies.forEach(item => {
    if (item.businessId && !uniqueMap.has(item.businessId)) {
      uniqueMap.set(item.businessId, item);
    }
  });

  return Array.from(uniqueMap.values());
}

// Save to local storage
async function loadAndSaveData(location, businessLine) {
  const companies = await fetchCompanies(location, businessLine);
  
  // Store as stringified JSON
  localStorage.setItem('savedCompanies', JSON.stringify(companies));
  console.log(`Saved ${companies.length} companies to localStorage.`);
}

// Retrieve from local storage
function getLocalCompanies() {
  const raw = localStorage.getItem('savedCompanies');
  return raw ? JSON.parse(raw) : [];
}

// Clear local storage
function clearLocalCompanies() {
  localStorage.removeItem('savedCompanies');
  console.log('Local storage cleared.');
}

function renderResults() {
  const raw = localStorage.getItem('savedCompanies');
  const companies = raw ? JSON.parse(raw) : [];

  if (companies.length === 0) {
    resultsDiv.innerHTML = '<p>No data stored.</p>';
    return;
  }

  resultsDiv.innerHTML = companies.map(c => `
    <div class="card">
      <h3>${c.name || 'Unnamed Company'}</h3>
      <p><strong>Business ID:</strong> ${c.businessId || 'N/A'}</p>
      <p><strong>Field:</strong> ${c.businessLine || 'N/A'}</p>
      <p><strong>Address:</strong> ${c.street || ''}, ${c.postCode || ''} ${c.city || ''}</p>
    </div>
  `).join('');
}

// Render existing data on page load
renderResults();