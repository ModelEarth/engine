/**
 * GitHub Issues Manager
 * Advanced issue tracking and management for ModelEarth repositories
 * 
 * Note: Uses 'modelearth' (lowercase) as GitHub user account to avoid 
 * organization OAuth requirements that would cause 401 authentication errors.
 */

/*
// This was in team rather than team/projects.
// Let's place this here instead and use minimal parameter to invoke from projects, projects/hub and team/projects

    // Initialize Projects Hub widget in minimal auth-only mode
    let githubAuthWidget;

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGitHubAuth);
    } else {
        initGitHubAuth();
    }

    function initGitHubAuth() {
        try {
            // Create minimal widget for auth only
            githubAuthWidget = new GitHubIssuesManager('github-auth-minimal', {
                githubToken: localStorage.getItem('github_token') || '',
                owner: 'modelearth',
                defaultRepo: 'team'
            });

            // Make it globally accessible
            window.issuesManager = githubAuthWidget;

            console.log('✅ GitHub Auth widget initialized (minimal mode)');
        } catch (error) {
            console.error('❌ Failed to initialize GitHub Auth widget:', error);
        }
    }
*/

class GitHubIssuesManager {
    constructor(containerId = 'issuesWidget', options = {}) {
        this.containerId = containerId;

        // Read configuration from data attributes or options
        const container = document.getElementById(containerId);
        const config = this.parseConfiguration(container, options);

        this.githubToken = localStorage.getItem('github_token') || '';
        this.baseURL = 'https://api.github.com';
        this.owner = config.githubOwner;
        this.detectCurrentFolder = config.detectCurrentFolder;
        this.multiRepoRoots = config.multiRepoRoots;
        this.showProject = config.showProject;
        this.showTokenSource = !!options.showTokenSource; // Adds "(Source: …)" after the rate limit text
        this.rowView = !!options.rowView; // Issues and comments as 2-line rows that expand on click
        this.currentFolder = this.getCurrentFolder();
        this.defaultRepo = this.determineDefaultRepo();

        this.perPage = 10;
        this.currentPage = 1;
        this.allIssues = [];
        this.filteredIssues = [];
        this.repositories = [];
        this.repositoryIssues = {}; // Cache for repository-specific issues
        this.repositoryIssueCounts = {}; // Cache for repository issue counts
        this.loadedAllRepositories = false; // Track if we've loaded all repos or just primary ones
        this.totalRepositoryCount = null; // Cache total repo count for UI display
        this.lastRefreshTime = null;
        this.autoRefreshInterval = null;
        this.assignees = new Set();
        this.labels = new Set();

        // Cache configuration (in minutes)
        this.cacheConfig = {
            duration: parseInt(localStorage.getItem('github_cache_duration')) || 10, // Default 10 minutes
            autoRefresh: localStorage.getItem('github_cache_auto_refresh') !== 'false' // Default true
        };
        this.cacheExpireTimer = null;
        this.rateLimitInfo = {
            remaining: null,
            resetTime: null,
            startTime: null
        };
        this.invalidTokenWarningShown = false; // Track if invalid token warning has been shown
        this.rateLimitWarningShown = false; // Track if rate limit warning has been shown
        this.tokenInputRevealed = false;
        this.saveTokenVisible = false;

        // State management
        this.filters = {
            repo: this.defaultRepo,
            sort: 'updated',
            assignee: 'all',
            projectstatus: 'open',
            label: 'all',
            search: ''
        };

        // UI state
        this.currentView = 'summary'; // Default view
        this.isFullscreen = false;
        this.currentRefreshIssueId = null;

        // Search debouncing
        this.searchDebounceTimer = null;
        this.searchDebounceDelay = 300; // 300ms delay

        // Track previous filter hash for cache invalidation
        this.previousFilterHash = null;

        this.init();
    }

    parseConfiguration(container, options) {
        const config = {
            githubOwner: 'modelearth',
            detectCurrentFolder: true,
            multiRepoRoots: ['webroot', 'modelearth'],
            showProject: true // Default to true (show projects list)
        };

        // Read from data attributes if container exists
        if (container) {
            if (container.dataset.githubOwner) {
                config.githubOwner = container.dataset.githubOwner;
            }
            if (container.dataset.detectCurrentFolder) {
                config.detectCurrentFolder = container.dataset.detectCurrentFolder === 'true';
            }
            if (container.dataset.multiRepoRoots) {
                config.multiRepoRoots = container.dataset.multiRepoRoots.split(',').map(s => s.trim());
            }
            if (container.dataset.showProject !== undefined) {
                config.showProject = container.dataset.showProject === 'true';
            }
        }

        // Override with explicit options
        return { ...config, ...options };
    }

    getCurrentFolder() {
        // Get current folder from URL path
        const path = window.location.pathname;
        const pathParts = path.split('/').filter(part => part.length > 0);

        // Return the first non-empty path segment (top-level folder)
        return pathParts.length > 0 ? pathParts[0] : '';
    }

    getHubPath() {
        // Determine the correct path to hub/repos.csv based on the script's location
        const scripts = document.getElementsByTagName('script');
        for (let script of scripts) {
            if (script.src && script.src.includes('issues.js')) {
                const srcAttribute = script.getAttribute('src');
                // If script src starts with ../js/ (from hub directory)
                if (srcAttribute && srcAttribute.startsWith('../js/')) {
                    return 'repos.csv';
                }
                // If script src is js/issues.js (from projects directory)
                else if (srcAttribute && srcAttribute === 'js/issues.js') {
                    return 'hub/repos.csv';
                }
                break;
            }
        }

        // Fallback: climb out of js folder and into hub folder
        return '../hub/repos.csv';
    }

    determineDefaultRepo() {
        if (!this.detectCurrentFolder) {
            return 'projects'; // Default fallback
        }

        // Always default to 'projects' repo for ModelEarth instead of loading all repos
        if (this.multiRepoRoots.includes(this.currentFolder)) {
            return 'projects';
        }

        // If current folder exists and is not a multi-repo root, use it as default
        if (this.currentFolder) {
            return this.currentFolder;
        }

        // Fallback to 'projects' if no folder detected
        return 'projects';
    }

    // Widget HTML template methods
    createWidgetStructure() {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error(`Container with id '${this.containerId}' not found`);
            return;
        }

        // When showProject is false, only create the header for authentication
        if (!this.showProject) {
            container.innerHTML = `
                ${this.createHeaderHTML()}
                <div id="projectsSectionsContainer" style="display: none;">
                    ${this.createRateLimitHTML()}
                    ${this.createLoadingOverlayHTML()}
                    ${this.createFiltersHTML()}
                    ${this.createIssuesContainerHTML()}
                    ${this.createStatsHTML()}
                    ${this.createCacheStatusHTML()}
                    ${this.createErrorHTML()}
                    ${this.createModalHTML()}
                </div>
            `;
            return;
        }

        // Full widget structure when showProject is true
        container.innerHTML = `
            ${this.createHeaderHTML()}
            ${this.createRateLimitHTML()}
            ${this.createLoadingOverlayHTML()}
            ${this.createFiltersHTML()}
            ${this.createIssuesContainerHTML()}
            ${this.createStatsHTML()}
            ${this.createCacheStatusHTML()}
            ${this.createErrorHTML()}
            ${this.createModalHTML()}
        `;
    }

    createHeaderHTML() {
        return `
            <div class="issues-header">
                <span class="material-icons header-fullscreen-btn" title="Toggle Fullscreen" style="cursor: pointer;">fullscreen</span>

                <div class="header-content">
                    <h1 id="hubHeaderTitle" style="font-size:32px;${this.showProject ? '' : 'display:none;'}"><svg class="mi-github" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> Team Projects</h1>
                    <div id="gitAccountHeaderRow" style="font-size: 0.9rem; padding: calc(0.35rem + 5px) 0 0.35rem 0;">
                        <span id="gitAccountDisplay" style="display: none; margin-bottom: 6px;"> Your GitHub account: <a href="#" id="gitAccountLink"></a>&nbsp;&nbsp;</span>
                        <a href="#" id="toggleTokenSection" class="btn-nice btn-white" style="margin-right: 8px;">Add My Token</a>
                        <a href="#" id="toggleProjectsSection" class="btn-nice btn-white" style="display: none;">View Projects</a>
                        <a href="#" id="toggleProjectFilters" class="btn-nice btn-white" style="display: none;" title="Show filters" aria-pressed="false"><svg class="filter-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"></polygon></svg></a>
                        <span id="headerLastRefreshTime" style="font-size: 0.9rem; display: none;"> Issue counts last updated: <span id="headerRefreshTime">Never</span>.</span>
                    </div>
                </div>
                
                <!-- GitHub Authentication -->
                <div class="auth-section" id="authSection" style="display: none;">
                    <div class="auth-input" id="auth-input">
                        <div class="config-field" style="flex: 0 1 160px; min-width: 160px; display: flex; flex-direction: column; gap: 0.25rem;">
                            <label for="gitIssuesAccount" class="config-label">Github Account</label>
                            <input type="text" id="gitIssuesAccount" class="textInput git-account-input" placeholder="GitHub Name" onfocus="this.select()">
                        </div>
                        <button id="addTokenButton" class="btn btn-secondary" type="button">
                            Add My Token
                        </button>
                        <div class="config-field" style="flex: 0 1 220px; min-width: 200px; display: flex; flex-direction: column; gap: 0.25rem;">
                            <label for="githubToken" class="config-label">Github Token (not password)</label>
                            <input type="password" id="githubToken" placeholder="Enter GitHub Personal Access Token (optional for public repos)">
                        </div>
                        <div class="auth-actions">
                            <button id="saveToken" class="btn btn-primary" style="display: none;">
                                <i class="material-icons mi">save</i> Save
                            </button>
                            <button id="clearToken" class="btn" style="display: none;">
                                Clear
                            </button>
                            <button id="getTokenLink" class="btn" type="button">Get Token</button>
                        </div>
                    </div>
                    <div class="auth-help" id="tokenBenefitText" style="display: none;">
                        <span><strong>Token Benefits:</strong> <span class="token-benefit-detail" id="tokenBenefitDetail"></span></span>
                    </div>
                    <div class="auth-instructions">
                        <details>
                            <summary>
                                <span><i class="material-icons mi">help</i> How to create a GitHub token?</span>
                            </summary>
                            <div class="instructions-content">
                                <ol>
                                    <li><a href="https://github.com/settings/tokens/new?description=ModelEarth+Projects+Hub&scopes=repo,read:org" target="_blank" rel="noopener noreferrer">Get Your Token</a> (opens GitHub)</li>
                                    <li>You'll be taken to GitHub's token creation page with recommended settings</li>
                                    <li>Add a description like "ModelEarth Projects Hub"</li>
                                    <li>Select scopes: <code>repo</code> (for private repos) and <code>read:org</code> (for organization data)</li>
                                    <li>Click "Generate token" at the bottom</li>
                                    <li>Copy the generated token immediately (you won't see it again!)</li>
                                    <li>Paste it in the field above and click "Save"</li>
                                </ol>
                                <p class="note">
                                    <span class="material-icons">shield</span>
                                    <strong>Security:</strong>
                                    <span class="note-text">Tokens are stored locally in your browser only. Never share your token with others.</span>
                                </p>
                            </div>
                        </details>
                    </div>
                </div>
            </div>
        `;
    }

    createRateLimitHTML() {
        return `
            <div id="rateLimitInfo" class="rate-limit-info" style="display: none;">
                <!-- Rate limit information will be displayed here -->
            </div>
        `;
    }

    createLoadingOverlayHTML() {
        return `
            <div class="loading-overlay" id="loadingOverlay">
                <div class="projects-loading-spinner">
                    <div class="spinner"></div>
                    <p>Loading GitHub data...</p>
                    <div class="loading-progress">
                        <div class="progress-bar" id="progressBar"></div>
                    </div>
                    <p class="loading-status" id="loadingStatus">Fetching repositories...</p>
                </div>
            </div>
        `;
    }

    createFiltersHTML() {
        return `
            <div class="filters-holder">
            <!-- Always visible filters row -->
            <div class="filters-always-visible">
                <!-- First row: View controls and repo filter -->
                <div class="filter-row-1">
                    <!-- View Controls (moved from issues container) -->
                    <div class="filter-group">
                        <select id="repoFilter" class="filter-select">
                            <option value="all">All Repositories</option>
                        </select>
                    </div>
                    <div class="view-controls">
                        <div class="view-toggle">
                            <button id="summaryView" class="view-btn active" title="Summary View">
                                <i class="material-icons">view_headline</i>
                            </button>
                            <button id="listView" class="view-btn" title="List View">
                                <i class="material-icons">format_list_bulleted</i>
                            </button>
                            <button id="cardView" class="view-btn" title="Card View">
                                <i class="material-icons">grid_view</i>
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Second row: Remaining 4 elements -->
                <div class="filter-row-2">
                    <!-- State Filter (moved from secondary row) -->
                    <div class="filter-group">
                        <button id="stateButton" class="filter-button compact-filter">
                            <i class="material-icons mi">error</i> Active
                            <i class="material-icons mi">expand_more</i>
                        </button>
                        <div class="dropdown-menu" id="stateDropdown">
                            <div class="dropdown-item" data-projectstatus="open">
                                <i class="material-icons mi">error</i> Active
                            </div>
                            <div class="dropdown-item" data-projectstatus="closed">
                                <i class="material-icons mi">check_circle</i> Closed
                            </div>
                            <div class="dropdown-item" data-projectstatus="all">
                                <i class="material-icons mi">list</i> All
                            </div>
                        </div>
                    </div>
                    
                    <!-- Labels Filter (moved from secondary row) -->
                    <div class="filter-group">
                        <button id="labelButton" class="filter-button compact-filter">
                            <i class="material-icons mi">label</i> Labels: All
                            <i class="material-icons mi">expand_more</i>
                        </button>
                        <div class="dropdown-menu" id="labelDropdown">
                            <div class="dropdown-item" data-label="all">
                                <i class="material-icons mi">label</i> All Labels
                            </div>
                        </div>
                    </div>
                    
          <button id="toggleFiltersBtn" class="toggle-filters-btn" title="Toggle Additional Filters" onclick="console.log('Container width:', this.closest('.filters-always-visible')?.offsetWidth + 'px');">
                        <i class="material-icons mi toggle-icon" style="display: none;">filter_alt</i>
                        <span class="toggle-text">More Filters</span>
                    </button>
                    
                    <button id="clearAllFiltersBtn" class="btn btn-secondary clear-filters-btn" style="display: none;">
                        <i class="material-icons mi clear-icon" style="display: none;">close</i>
                        <span class="clear-text">Clear</span>
                    </button>
                </div>
            </div>

            <!-- Collapsible additional filters section -->
            <div class="filters-section" id="filtersSection" style="display: none;">
                <!-- Additional filter buttons -->
                <div class="filters-row filters-secondary-row additional-filters">
                    <!-- Assigned to filter (moved from main row) -->
                    <div class="filter-group">
                        <button id="assigneeButton" class="filter-button">
                            <i class="material-icons mi">person</i> Assigned to: All
                            <i class="material-icons mi">expand_more</i>
                        </button>
                        <div class="dropdown-menu" id="assigneeDropdown">
                            <div class="dropdown-item" data-assignee="all">
                                <i class="material-icons mi">group</i> All Users
                            </div>
                            <div class="dropdown-item" data-assignee="unassigned">
                                <i class="material-icons mi">person_off</i> Unassigned
                            </div>
                        </div>
                    </div>

                    <!-- Sort filter (moved from main row) -->
                    <div class="filter-group">
                        <button id="sortButton" class="filter-button">
                            <i class="material-icons mi">sort</i> Sort by: Updated
                            <i class="material-icons mi">expand_more</i>
                        </button>
                        <div class="dropdown-menu" id="sortDropdown">
                            <div class="dropdown-item" data-sort="updated">
                                <i class="material-icons mi">event</i> Updated Date
                            </div>
                            <div class="dropdown-item" data-sort="created">
                                <i class="material-icons mi">add</i> Created Date
                            </div>
                            <div class="dropdown-item" data-sort="comments">
                                <i class="material-icons mi">forum</i> Comment Count
                            </div>
                            <div class="dropdown-item" data-sort="title">
                                <i class="material-icons mi">sort_by_alpha</i> Title (A-Z)
                            </div>
                            <div class="dropdown-item" data-sort="number">
                                <i class="material-icons mi">tag</i> Issue Number
                            </div>
                        </div>
                    </div>
                    
                    <div class="filter-group" style="margin-left: auto;">
                        <button id="clearCacheButton" class="btn btn-primary">
                            Clear Cache
                        </button>
                    </div>
                </div>

                <!-- Search row -->
                
                <!-- Third row: Search -->
<div class="filter-row-3">
  <div class="search-container">
    <div class="search-group">
      <input id="searchInput" type="text" placeholder="Enter Search " />
      <button id="searchButton" class="btn btn-primary">
        <i class="material-icons mi">search</i>
      </button>
      <button id="clearSearch" class="btn btn-clear-search" title="Clear" style="display:none">
        <i class="material-icons mi">close</i>
      </button>
    </div>
  </div>

  <!-- NEW: live counts -->
  <div class="search-stats" id="searchStats" aria-live="polite"></div>
</div>

            </div>
            </div>
        `;
    }

    createIssuesContainerHTML() {
        return `
            <div class="issues-container" id="issuesContainer" style="display: none;">
                
                <div class="issues-list" id="issuesList">
                    <!-- Issues will be dynamically loaded here -->
                </div>

                <!-- Pagination -->
                <div class="pagination-container" id="paginationContainer">
                    <div class="pagination-info">
                        <span id="paginationInfo">Showing 0 of 0 issues</span>
                    </div>
                    <div class="pagination-controls" id="paginationControls">
                        <!-- Pagination buttons will be generated here -->
                    </div>
                </div>
            </div>
        `;
    }

    createStatsHTML() {
        return `
            <div class="stats-section" id="statsSection" style="display: none;">
                <a class="stat-card" href="/codechat">
                    <div class="stat-icon">
                        <i class="material-icons mi">call_split</i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="repoCount">0</div>
                        <div class="stat-label">Repositories</div>
                    </div>
                </a>
                <a class="stat-card" href="https://github.com/modelearth/projects/issues/" target="_blank" rel="noopener">
                    <div class="stat-icon">
                        <i class="material-icons mi">error</i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="openIssueCount">0</div>
                        <div class="stat-label">Open Issues</div>
                    </div>
                </a>
                <a class="stat-card" href="https://github.com/modelearth/projects/issues/" target="_blank" rel="noopener">
                    <div class="stat-icon">
                        <i class="material-icons mi">check_circle</i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="closedIssueCount">0</div>
                        <div class="stat-label">Closed Issues</div>
                    </div>
                </a>
                <a class="stat-card" href="https://github.com/modelearth/projects/issues/" target="_blank" rel="noopener">
                    <div class="stat-icon">
                        <i class="material-icons mi">forum</i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="totalComments">0</div>
                        <div class="stat-label">Comments</div>
                    </div>
                </a>
            </div>
        `;
    }

    createCacheStatusHTML() {
        return `
            <div class="cache-status-section">
                <div id="cacheStatus" class="cache-status">
                    <span>Cache: Loading...</span>
                </div>
            </div>
        `;
    }

    createErrorHTML() {
        return `
            <div class="error-message" id="errorMessage" style="display: none;">
                <div class="error-icon">
                    <i class="material-icons mi">warning</i>
                </div>
                <div class="error-content">
                    <h3>Error Loading Issues</h3>
                    <p id="errorText">Failed to load GitHub data. Please check your connection and try again.</p>
                    <button id="retryButton" class="btn btn-primary">
                        <i class="material-icons mi">redo</i> Retry
                    </button>
                </div>
            </div>
        `;
    }

    createModalHTML() {
        return `
            <div class="modal-overlay" id="issueModal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 id="modalTitle">Issue Details</h2>
                        <button class="modal-close" id="modalClose">
                            <i class="material-icons mi">close</i>
                        </button>
                    </div>
                    <div class="modal-body" id="modalBody">
                        <!-- Issue details will be loaded here -->
                    </div>
                </div>
            </div>
            
            <!-- Refresh Dialog -->
            <div class="modal-overlay" id="refreshDialog" style="display: none;">
                <div class="modal-content" style="max-width: 400px;">
                    <div class="modal-header">
                        <h2 id="refreshDialogTitle">Refresh Issue</h2>
                        <button class="modal-close" id="refreshDialogClose">
                            <i class="material-icons mi">close</i>
                        </button>
                    </div>
                    <div class="modal-body">
                        <p>Do you want to refresh this issue with the latest data from GitHub?</p>
                        <div class="refresh-dialog-actions" style="margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end;">
                            <button class="btn btn-secondary" id="refreshDialogCancel">Cancel</button>
                            <button class="btn btn-primary" id="refreshDialogConfirm">
                                <i class="material-icons mi">sync</i> Refresh Issue
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    async init() {
        // Create the widget structure first
        this.createWidgetStructure();

        // If showProject is false, don't load data or setup most functionality
        // This creates a minimal widget showing only the .issues-header for authentication
        if (!this.showProject) {
            this.projectsViewInitialized = false;
            this.setupTokenEventListeners();

            // Try to load token from API if not in localStorage
            await this.loadTokenFromAPI();

            this.updateTokenUI();
            this.updateTokenSectionUI();

            // Make the widget visible but minimal (header only)
            this.initialized = false; // Track that we haven't fully initialized yet
            return;
        }

        // Full initialization for showProject=true
        await this.initializeFullProjectView();
    }

    async initializeFullProjectView() {
        if (this.projectsViewInitialized) {
            return;
        }

        this.projectsViewInitialized = true;
        this.initialized = true;

        // Try to load token from API if not in localStorage
        await this.loadTokenFromAPI();

        // Ensure initial responsive state is correct
        this.updateAssigneeButton();
        this.updateToggleButtonDisplay();

        // Initialize previous filter hash for tracking changes
        this.previousFilterHash = window.location.hash.substring(1);

        this.setupEventListeners();
        this.setupMenuClickHandler(); // Add menu click handler
        this.loadFromHash();
        this.loadFromCache();
        this.updateTokenUI();
        this.updateTokenSectionUI();

        // Load saved view preference
        this.loadViewPreference();

        // Auto-detect owner from current URL or default to ModelEarth
        this.detectOwner();

        // Load rate limit info from cache
        this.loadRateLimitFromCache();

        // If we have a token but no recent rate limit info, clear it to get fresh data
        if (this.githubToken && this.rateLimitInfo.remaining !== null) {
            const now = Date.now();
            const resetTime = new Date(this.rateLimitInfo.resetTime).getTime();
            // If reset time has passed, clear the old info
            if (now > resetTime) {
                this.clearRateLimit();
            }
        }

        this.startRateLimitTimer();

        await this.loadData();

        // Start auto-refresh timer only if we have a token
        if (this.githubToken) {
            this.startAutoRefreshTimer();
        } else {
        }

        // Add resize observer to handle responsive label changes
        this.setupResizeObserver();
    }

    /**
     * Complete initialization for widgets that started with showProject=false
     * Call this when user clicks "Repos" button in team/projects
     * This only initializes authentication, NOT the projects list
     */
    async initializeProjectsList() {
        if (this.initialized) {
            // Already initialized, nothing to do
            return;
        }

        // Mark as initialized (but keep showProject=false to avoid showing projects)
        this.initialized = true;

        // Note: We deliberately keep showProject=false here
        // This ensures only .issues-header is shown for authentication
        // No projects list, filters, or stats will be displayed

        // Only setup what's needed for authentication
        this.loadRateLimitFromCache();

        // If we have a token but no recent rate limit info, clear it to get fresh data
        if (this.githubToken && this.rateLimitInfo.remaining !== null) {
            const now = Date.now();
            const resetTime = new Date(this.rateLimitInfo.resetTime).getTime();
            // If reset time has passed, clear the old info
            if (now > resetTime) {
                this.clearRateLimit();
            }
        }

        this.startRateLimitTimer();

        // Don't load projects data when showProject is false
        // User only wants authentication UI, not the projects list
    }

    updateSearchStatus() {
        const el = document.getElementById('searchStats');
        if (!el) return;

        // filters considered "active" when anything differs from defaults OR a search term exists
        const defaults = { sort: 'updated', assignee: 'all', projectstatus: 'open', label: 'all' };
        const anyNonDefault = Object.keys(defaults).some(k => this.filters[k] !== defaults[k]);
        const active = anyNonDefault || (this.filters.search && this.filters.search.trim().length > 0);

        if (!active) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }

        const count = this.filteredIssues?.length ?? 0;
        const project = this.allIssues?.length ?? 0;

        // repos shown → if 'all', count unique repos in CURRENT filtered set; else it's 1
        let repo = 1;
        if (this.filters.repo === 'all') {
            const s = new Set((this.filteredIssues || []).map(i => i.repository));
            repo = s.size || (this.repositoryIssueCounts ? Object.keys(this.repositoryIssueCounts).length : 1);
        }

        el.textContent = `${count} matches out of ${project} projects in ${repo} repos`;
        el.style.display = 'block';
    }


    setupResizeObserver() {
        // Create a resize observer to watch the filter container width
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    // Update assignee button when container width changes
                    this.updateAssigneeButton();
                    this.updateToggleButtonDisplay();
                }
            });

            // Start observing the filters container
            const container = document.querySelector('.filters-always-visible');
            if (container) {
                observer.observe(container);
            }
        } else {
            // Fallback for browsers without ResizeObserver support
            window.addEventListener('resize', () => {
                this.updateAssigneeButton();
                this.updateToggleButtonDisplay();
            });
        }
    }

    updateToggleButtonDisplay() {
        const container = document.querySelector('.filters-always-visible');
        const toggleBtn = document.getElementById('toggleFiltersBtn');
        const clearBtn = document.getElementById('clearAllFiltersBtn');

        if (container && toggleBtn) {
            const isNarrow = container.offsetWidth < 600;

            // Toggle classes for narrow container
            toggleBtn.classList.toggle('narrow-container', isNarrow);
            if (clearBtn) {
                clearBtn.classList.toggle('narrow-container', isNarrow);
            }

            // Show/hide icons and text based on container width
            const toggleIcon = toggleBtn.querySelector('.toggle-icon');
            const toggleText = toggleBtn.querySelector('.toggle-text');
            const clearIcon = clearBtn?.querySelector('.clear-icon');
            const clearText = clearBtn?.querySelector('.clear-text');

            if (isNarrow) {
                // Show icons, hide text
                if (toggleIcon) toggleIcon.style.display = 'inline';
                if (toggleText) toggleText.style.display = 'none';
                if (clearIcon) clearIcon.style.display = 'inline';
                if (clearText) clearText.style.display = 'none';
            } else {
                // Show text, hide icons
                if (toggleIcon) toggleIcon.style.display = 'none';
                if (toggleText) toggleText.style.display = 'inline';
                if (clearIcon) clearIcon.style.display = 'none';
                if (clearText) clearText.style.display = 'inline';
            }
        }
    }

    detectOwner() {
        // Try to detect owner from URL or use default
        const hostname = window.location.hostname;
        if (hostname.includes('modelearth') || hostname.includes('model.earth')) {
            this.owner = 'modelearth';
        }
        // Could Add more detection logic here
    }

    async loadRepositoriesWithIssues() {

        // Start with projects repo as default and highest priority
        const repositoriesWithIssues = [];
        const csvRepos = await this.loadRepositoriesFromCSV();

        // Always Add projects repo first (default selection)
        const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
        if (projectsRepo) {
            repositoriesWithIssues.push({
                name: projectsRepo.repo_name,
                displayName: projectsRepo.display_name,
                description: projectsRepo.description,
                defaultBranch: projectsRepo.default_branch,
                openIssueCount: null, // Will be loaded
                totalIssueCount: null,
                repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`,
                priority: 1 // Highest priority for lazy loading
            });
        }

        // Check other repos for issues (excluding projects since we already added it)
        const otherRepos = csvRepos.filter(repo => repo.repo_name !== 'projects');

        for (const repo of otherRepos) {
            try {
                // Quick check if repo has any open issues (most important for active repos)
                const openCount = await this.getRepositoryIssueCount(repo.repo_name, 'open');

                // For filtering purposes, we only need to know if there are any issues
                // Open issues are sufficient to determine if repo should be included
                if (openCount > 0) {
                    repositoriesWithIssues.push({
                        name: repo.repo_name,
                        displayName: repo.display_name,
                        description: repo.description,
                        defaultBranch: repo.default_branch,
                        openIssueCount: openCount, // Set the known open count
                        totalIssueCount: null, // Will be determined when issues are loaded
                        repository_url: `https://github.com/${this.owner}/${repo.repo_name}`,
                        priority: 2 // Lower priority for lazy loading
                    });
                }
            } catch (error) {
            }
        }

        return repositoriesWithIssues;
    }

    async loadRepositoriesFromCSV() {
        try {
            const response = await fetch(this.getHubPath());
            if (!response.ok) {
                throw new Error(`CSV fetch failed: ${response.status}`);
            }
            const csvText = await response.text();
            const parsed = this.parseCSV(csvText);
            return parsed;
        } catch (error) {
            console.error('Error loading repositories from CSV:', error);
            // Fallback to hardcoded list (updated with additional repositories)
            return [
                { repo_name: 'modelearth', display_name: 'ModelEarth', description: 'Main ModelEarth repository', default_branch: 'master' },
                { repo_name: 'localsite', display_name: 'LocalSite', description: 'Core CSS/JS utilities', default_branch: 'main' },
                { repo_name: 'realitystream', display_name: 'RealityStream', description: 'ML Models and Visualization', default_branch: 'main' },
                { repo_name: 'feed', display_name: 'Feed', description: 'FeedPlayer video/gallery', default_branch: 'main' },
                { repo_name: 'swiper', display_name: 'Swiper', description: 'UI swiper components', default_branch: 'main' },
                { repo_name: 'comparison', display_name: 'Comparison', description: 'Trade Flow tools', default_branch: 'main' },
                { repo_name: 'codechat', display_name: 'CodeChat', description: 'Code chat interface', default_branch: 'main' },
                { repo_name: 'home', display_name: 'Home', description: 'Home page content', default_branch: 'main' },
                { repo_name: 'cloud', display_name: 'Cloud', description: 'Cloud platform tools', default_branch: 'main' },
                { repo_name: 'projects', display_name: 'Projects', description: 'Project showcases', default_branch: 'main' },
                { repo_name: 'team', display_name: 'Team', description: 'Rust REST API for Azure', default_branch: 'main' },
                { repo_name: 'products', display_name: 'Products', description: 'Products frontend and python', default_branch: 'main' },
                { repo_name: 'products-data', display_name: 'Products Data', description: 'Products data output', default_branch: 'main' },
                { repo_name: 'profile', display_name: 'Profile', description: 'Profile frontend analysis', default_branch: 'main' },
                { repo_name: 'exiobase', display_name: 'Exiobase', description: 'Trade flow output to .csv and SQL', default_branch: 'main' },
                { repo_name: 'io', display_name: 'IO', description: 'Input-output analysis', default_branch: 'main' },
                { repo_name: 'useeio.js', display_name: 'USEEIO.JS', description: 'JavaScript footprint tools', default_branch: 'dev' },
                { repo_name: 'useeio-widgets', display_name: 'USEEIO Widgets', description: 'USEEIO React widgets', default_branch: 'master' },
                { repo_name: 'useeio-widgets-without-react', display_name: 'USEEIO Widgets Without React', description: 'USEEIO widgets without React', default_branch: 'master' },
                { repo_name: 'useeiopy', display_name: 'USEEIO Python', description: 'Python USEEIO library', default_branch: 'master' },
                { repo_name: 'useeio_api', display_name: 'USEEIO API', description: 'USEEIO REST API', default_branch: 'master' },
                { repo_name: 'useeio', display_name: 'USEEIO Core', description: 'Core USEEIO model', default_branch: 'master' },
                { repo_name: 'useeior', display_name: 'USEEIO R', description: 'R package for USEEIO', default_branch: 'master' },
                { repo_name: 'useeio-state', display_name: 'USEEIO State', description: 'State-level USEEIO data', default_branch: 'main' },
                { repo_name: 'useeio-json', display_name: 'USEEIO JSON', description: 'USEEIO JSON data', default_branch: 'main' },
                { repo_name: 'mario', display_name: 'Mario', description: 'Multi-regional input-output', default_branch: 'main' },
                { repo_name: 'webroot', display_name: 'Webroot', description: 'PartnerTools webroot', default_branch: 'main' },
                { repo_name: 'data-pipeline', display_name: 'Data Pipeline', description: 'Python data processing pipeline', default_branch: 'main' },
                { repo_name: 'community-data', display_name: 'Community data', description: 'Community-level data outputs', default_branch: 'master' },
                { repo_name: 'community-timelines', display_name: 'Community Timeline', description: 'Timeline data for communities', default_branch: 'main' },
                { repo_name: 'community-zipcodes', display_name: 'Community Zipcodes', description: 'ZIP code level community data', default_branch: 'main' },
                { repo_name: 'community-forecasting', display_name: 'Community Forecasting', description: 'Forecasting frontend', default_branch: 'main' },
                { repo_name: 'dataflow', display_name: 'Data flow', description: 'Data flow NextJS UX', default_branch: 'main' },
            ];
        }
    }

    async detectEntityType() {
        const cacheKey = `github_entity_type_${this.owner}`;
        const cacheTimeKey = `github_entity_type_time_${this.owner}`;

        // Check cache first (valid for 24 hours)
        const cachedType = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedType && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours

            if (age < twentyFourHours) {
                return cachedType;
            }
        }

        // Try to detect if it's an organization or user
        try {
            // First try organization endpoint
            try {
                await this.apiRequest(`/orgs/${this.owner}`);
                localStorage.setItem(cacheKey, 'org');
                localStorage.setItem(cacheTimeKey, Date.now().toString());
                return 'org';
            } catch (orgError) {
                // If org fails, try user endpoint
                try {
                    await this.apiRequest(`/users/${this.owner}`);
                    localStorage.setItem(cacheKey, 'user');
                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                    return 'user';
                } catch (userError) {
                    console.warn(`Could not determine entity type for ${this.owner}, defaulting to user`);
                    localStorage.setItem(cacheKey, 'user');
                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                    return 'user';
                }
            }
        } catch (error) {
            console.warn(`Error detecting entity type for ${this.owner}:`, error);
            return 'user'; // Default fallback
        }
    }

    async loadRepositoriesFromGitHub(specificRepos = null) {
        const isLoadingAll = specificRepos === null;
        const cacheKey = isLoadingAll ? 'github_all_repos' : `github_repos_${specificRepos.join('_')}`;
        const cacheTimeKey = isLoadingAll ? 'github_all_repos_time' : `github_repos_${specificRepos.join('_')}_time`;

        // Check if we have cached data that's less than 1 hour old
        const cachedData = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedData && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

            if (age < oneHour) {
                return JSON.parse(cachedData);
            }
        }

        // Fetch fresh data from GitHub API
        if (!this.githubToken) {
            return null;
        }

        const repos = [];

        if (isLoadingAll) {

            // Detect if this is an organization or user account
            const entityType = await this.detectEntityType();
            const endpoint = entityType === 'org'
                ? `/orgs/${this.owner}/repos`
                : `/users/${this.owner}/repos`;

            let page = 1;
            const perPage = 100;

            while (true) {
                const pageRepos = await this.apiRequest(`${endpoint}?per_page=${perPage}&page=${page}&type=all&sort=name`);

                if (pageRepos.length === 0) break;

                // Add repos that have issues
                const reposWithIssues = pageRepos.filter(repo => repo.has_issues && !repo.archived);
                repos.push(...reposWithIssues.map(repo => ({
                    repo_name: repo.name,
                    display_name: repo.name,
                    description: repo.description || '',
                    default_branch: repo.default_branch || 'main',
                    open_issues_count: repo.open_issues_count,
                    html_url: repo.html_url
                })));

                page++;
                if (pageRepos.length < perPage) break; // Last page
            }

        } else {

            // Fetch specific repositories
            for (const repoName of specificRepos) {
                try {
                    const repo = await this.apiRequest(`/repos/${this.owner}/${repoName}`);
                    if (repo.has_issues && !repo.archived) {
                        repos.push({
                            repo_name: repo.name,
                            display_name: repo.name,
                            description: repo.description || '',
                            default_branch: repo.default_branch || 'main',
                            open_issues_count: repo.open_issues_count,
                            html_url: repo.html_url
                        });
                    }
                } catch (error) {
                    console.warn(`Failed to fetch repository ${repoName}:`, error);
                }
            }

        }

        // Cache the results
        localStorage.setItem(cacheKey, JSON.stringify(repos));
        localStorage.setItem(cacheTimeKey, Date.now().toString());

        return repos;
    }

    async loadAllRepositories() {
        if (this.loadedAllRepositories) {
            return;
        }

        this.updateLoadingStatus('Loading all repositories...');

        try {
            const allRepos = await this.loadRepositoriesFromGitHub(null); // null = load all

            if (allRepos && allRepos.length > 0) {
                this.repositories = allRepos.map(apiRepo => ({
                    name: apiRepo.repo_name,
                    displayName: apiRepo.display_name,
                    description: apiRepo.description,
                    defaultBranch: apiRepo.default_branch,
                    openIssueCount: apiRepo.open_issues_count,
                    totalIssueCount: null,
                    repository_url: apiRepo.html_url || `https://github.com/${this.owner}/${apiRepo.repo_name}`
                }));

                this.loadedAllRepositories = true;

                // Load issue counts for all repositories when explicitly loading all
                await this.loadRepositoryIssueCountsForDisplayed();

                // Update UI
                this.populateRepositoryFilter();
                this.showNotification(`Loaded ${this.repositories.length} repositories`, 'success');
            }
        } catch (error) {
            console.error('Error loading all repositories:', error);
            this.showNotification('Failed to load all repositories', 'error');
        }
    }

    async getRepositoryCount() {
        // Check if we have cached count that's less than 1 hour old
        const cacheKey = 'github_repo_count';
        const cacheTimeKey = 'github_repo_count_time';

        const cachedCount = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCount && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const oneHour = 60 * 60 * 1000;

            if (age < oneHour) {
                return parseInt(cachedCount);
            }
        }

        if (!this.githubToken) {
            return null;
        }

        try {
            // Detect if this is an organization or user account
            const entityType = await this.detectEntityType();
            const endpoint = entityType === 'org'
                ? `/orgs/${this.owner}`
                : `/users/${this.owner}`;

            const entity = await this.apiRequest(endpoint);
            const totalRepos = entity.public_repos || 0;

            // For more accurate count, make one API call to get first page and total
            const reposEndpoint = entityType === 'org'
                ? `/orgs/${this.owner}/repos`
                : `/users/${this.owner}/repos`;

            const firstPage = await this.apiRequest(`${reposEndpoint}?per_page=1&type=all`);

            // Get the actual count from Link header or estimate based on public_repos
            let actualCount = totalRepos;

            // Filter for repositories with issues enabled (rough estimate)
            if (firstPage && firstPage.length > 0) {
                // Make a small sample to estimate percentage with issues
                const sample = await this.apiRequest(`${reposEndpoint}?per_page=10&type=all`);
                const withIssues = sample.filter(repo => repo.has_issues && !repo.archived).length;
                const percentage = withIssues / sample.length;
                actualCount = Math.round(totalRepos * percentage);
            }


            // Cache the result
            localStorage.setItem(cacheKey, actualCount.toString());
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            return actualCount;
        } catch (error) {
            console.warn('Failed to get repository count:', error);
            return null;
        }
    }

    parseCSV(csvText) {
        const lines = csvText.trim().split('\n');
        const headers = lines[0].split(',');
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index];
            });
            data.push(row);
        }

        return data;
    }

    loadRateLimitFromCache() {
        try {
            const cached = localStorage.getItem('github_rate_limit_info');
            if (cached) {
                this.rateLimitInfo = JSON.parse(cached);

                // Check if rate limit period has passed
                if (this.rateLimitInfo.resetTime && new Date() > new Date(this.rateLimitInfo.resetTime)) {
                    this.clearRateLimit();
                }
            }
        } catch (error) {
            console.warn('Failed to load rate limit info from cache:', error);
        }
    }

    saveRateLimitToCache() {
        try {
            localStorage.setItem('github_rate_limit_info', JSON.stringify(this.rateLimitInfo));
        } catch (error) {
            console.warn('Failed to save rate limit info to cache:', error);
        }
    }

    clearRateLimit() {
        this.rateLimitInfo = {
            remaining: null,
            resetTime: null,
            startTime: null
        };
        localStorage.removeItem('github_rate_limit_info');
        this.updateRateLimitDisplay();
    }

    // Cache management functions
    setupCacheExpirationTimer(timeUntilExpiration) {
        // Don't set auto-refresh timer without a token
        if (!this.githubToken) {
            return;
        }

        // Clear existing timer
        if (this.cacheExpireTimer) {
            clearTimeout(this.cacheExpireTimer);
        }

        // Set new timer for auto-refresh
        this.cacheExpireTimer = setTimeout(() => {
            this.loadData(true); // Force refresh
        }, timeUntilExpiration);

    }

    updateCacheStatusDisplay() {
        const cacheStatusDiv = document.getElementById('cacheStatus');
        if (!cacheStatusDiv) return;

        // Check both base and filtered caches
        const baseCache = localStorage.getItem('github_issues_base_cache');
        const filteredCache = localStorage.getItem('github_issues_filtered_cache');
        const cached = filteredCache || baseCache;

        if (cached) {
            try {
                const data = JSON.parse(cached);
                const cacheAge = Date.now() - data.timestamp;
                const cacheAgeMinutes = Math.round(cacheAge / 60000);
                const remainingMinutes = Math.max(0, this.cacheConfig.duration - cacheAgeMinutes);
                const cacheType = filteredCache ? 'Filtered' : 'Base';

                cacheStatusDiv.innerHTML = `
                    <span>
                        ${cacheType} Cache: ${cacheAgeMinutes}m old, expires in ${remainingMinutes}m
                        (${this.cacheConfig.duration}m duration)
                        ${this.cacheConfig.autoRefresh ? ' • Auto-refresh enabled' : ' • Auto-refresh disabled'}
                    </span>
                `;
            } catch (error) {
                cacheStatusDiv.innerHTML = '<span>Cache: Invalid</span>';
            }
        } else {
            cacheStatusDiv.innerHTML = '<span>Cache: Empty</span>';
        }
    }

    setCacheDuration(minutes) {
        this.cacheConfig.duration = Math.max(1, Math.min(60, minutes)); // Limit between 1-60 minutes
        localStorage.setItem('github_cache_duration', this.cacheConfig.duration.toString());

        // Clear existing caches to apply new duration
        localStorage.removeItem('github_issues_base_cache');
        localStorage.removeItem('github_issues_filtered_cache');
        this.clearRepositoryCache();

        this.showNotification(`Cache duration set to ${this.cacheConfig.duration} minutes`, 'info');
        this.updateCacheStatusDisplay();

        // Reload data with new cache settings
        this.loadData(true);
    }

    toggleAutoRefresh() {
        this.cacheConfig.autoRefresh = !this.cacheConfig.autoRefresh;
        localStorage.setItem('github_cache_auto_refresh', this.cacheConfig.autoRefresh.toString());

        if (!this.cacheConfig.autoRefresh && this.cacheExpireTimer) {
            clearTimeout(this.cacheExpireTimer);
            this.cacheExpireTimer = null;
        }

        this.showNotification(`Auto-refresh ${this.cacheConfig.autoRefresh ? 'enabled' : 'disabled'}`, 'info');
        this.updateCacheStatusDisplay();
    }

    updateRateLimitDisplay() {
        const rateLimitDiv = document.getElementById('rateLimitInfo');
        if (!rateLimitDiv) return;

        // Always show invalid token message if present
        if (this.invalidTokenMessage) {
            rateLimitDiv.innerHTML = `
                <div class="rate-limit-warning">
                    <i class="material-icons mi">warning</i>
                    <div class="rate-limit-content">
                        <div class="rate-limit-title">Invalid GitHub Token</div>
                        <div class="rate-limit-details">${this.invalidTokenMessage}</div>
                    </div>
                </div>
            `;
            rateLimitDiv.style.display = 'block';
            return; // Don't show rate limit info if token is invalid
        }

        if (this.rateLimitInfo.remaining !== null) {
            const resetTime = new Date(this.rateLimitInfo.resetTime);
            const now = new Date();
            const timeLeft = Math.max(0, resetTime - now);
            const minutesLeft = Math.ceil(timeLeft / 60000);
            const remaining = this.rateLimitInfo.remaining;

            // Show warning when running low on requests, recently hit limit, or no token
            const isLowOnRequests = remaining < 100;
            const isRateLimited = remaining === 0 && timeLeft > 0;
            const isWithoutToken = !this.githubToken && remaining <= 60; // Anonymous limit is 60

            const shouldShowWarning = isLowOnRequests || isRateLimited;
            const shouldShowInfo = isWithoutToken && !isRateLimited;

            if (shouldShowWarning && timeLeft > 0) {
                rateLimitDiv.innerHTML = `
                    <div class="rate-limit-warning">
                        <i class="material-icons mi">schedule</i>
                        <div class="rate-limit-content">
                            <div class="rate-limit-title">API Rate Limit Warning: ${remaining} requests remaining. Resets in ${minutesLeft} minutes (${resetTime.toLocaleTimeString()})</div>
                        </div>
                    </div>
                `;
                rateLimitDiv.style.display = 'block';
            } else if (shouldShowInfo) {
                // Show informational rate limit for users without token
                rateLimitDiv.innerHTML = `
                    <div class="rate-limit-info-display">
                        <i class="material-icons mi">info</i>
                        <div class="rate-limit-content">
                            <div class="rate-limit-title">API Rate Limit: ${remaining} requests remaining (without token). ${timeLeft > 0 ? `Resets in ${minutesLeft} minutes (${resetTime.toLocaleTimeString()})` : 'Resets hourly'}</div>
                        </div>
                    </div>
                `;
                rateLimitDiv.style.display = 'block';
            } else {
                rateLimitDiv.style.display = 'none';
            }
        } else {
            rateLimitDiv.style.display = 'none';
        }

        // Update the header text with current rate limit info
        this.updateTokenSectionUI();
    }

    showInvalidTokenMessage(message) {
        const rateLimitDiv = document.getElementById('rateLimitInfo');
        if (!rateLimitDiv) return;

        // Store the invalid token message to show alongside rate limit info
        this.invalidTokenMessage = `${message}. Please update your token above or remove it to use anonymous access (60 requests/hour).`;

        rateLimitDiv.innerHTML = `
            <div class="rate-limit-warning">
                <i class="material-icons mi">warning</i>
                <div class="rate-limit-content">
                    <div class="rate-limit-title">Invalid GitHub Token</div>
                    <div class="rate-limit-details">${this.invalidTokenMessage}</div>
                </div>
            </div>
        `;
        rateLimitDiv.style.display = 'block';
    }

    startRateLimitTimer() {
        // Update rate limit display every minute
        if (this.rateLimitTimer) {
            clearInterval(this.rateLimitTimer);
        }

        this.rateLimitTimer = setInterval(() => {
            this.updateRateLimitDisplay();
        }, 60000); // Update every minute
    }

    setupTokenEventListeners() {
        if (this.tokenEventListenersBound) {
            return;
        }
        this.tokenEventListenersBound = true;

        // Token management only - for minimal mode (showProject=false)
        const toggleTokenSection = document.getElementById('toggleTokenSection');
        const toggleProjectsSection = document.getElementById('toggleProjectsSection');
        const saveToken = document.getElementById('saveToken');
        const clearToken = document.getElementById('clearToken');
        const addTokenButton = document.getElementById('addTokenButton');
        const fullscreenBtn = document.querySelector('.header-fullscreen-btn');

        if (toggleTokenSection) {
            toggleTokenSection.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleTokenSection();
            });
        }
        if (toggleProjectsSection) {
            toggleProjectsSection.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.toggleProjectsSection();
            });
        }
        const toggleProjectFilters = document.getElementById('toggleProjectFilters');
        if (toggleProjectFilters) {
            toggleProjectFilters.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleProjectFilters();
            });
        }
        if (saveToken) {
            saveToken.addEventListener('click', () => this.saveToken());
        }
        if (clearToken) {
            clearToken.addEventListener('click', () => this.clearToken());
        }
        if (addTokenButton) {
            addTokenButton.addEventListener('click', () => this.revealTokenInput());
        }
        document.querySelectorAll('.view-steps-link').forEach(link => {
            const details = link.closest('details');
            if (details) {
                this.updateViewStepsLinkLabel(details, link);
                details.addEventListener('toggle', () => this.updateViewStepsLinkLabel(details, link));
            }

            link.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (details) {
                    if (details.hasAttribute('open')) {
                        details.removeAttribute('open');
                    } else {
                        details.setAttribute('open', '');
                    }
                    this.updateViewStepsLinkLabel(details, link);
                }
            });
        });
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        }

        const tokenInputEl = document.getElementById('githubToken');
        if (tokenInputEl) {
            tokenInputEl.addEventListener('focus', () => {
                if (!this.githubToken) {
                    this.saveTokenVisible = true;
                    const saveBtn = document.getElementById('saveToken');
                    if (saveBtn) saveBtn.style.display = '';
                }
            });
        }

        const getTokenLink = document.getElementById('getTokenLink');

        const toggleAuthInstructions = () => {
            const authInstructionsDetails = document.querySelector('.auth-instructions details');
                if (authInstructionsDetails) {
                    if (authInstructionsDetails.hasAttribute('open')) {
                        authInstructionsDetails.removeAttribute('open');
                        if (getTokenLink) getTokenLink.style.display = this.githubToken ? 'none' : '';
                    } else {
                        authInstructionsDetails.setAttribute('open', '');
                        if (getTokenLink) getTokenLink.style.display = 'none';
                    const summary = authInstructionsDetails.querySelector('summary');
                    if (summary) summary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        };

        if (getTokenLink) {
            getTokenLink.addEventListener('click', (e) => {
                e.preventDefault();
                toggleAuthInstructions();
            });
        }

        this.updateAuthInstructionsCompactState();
    }

    setupEventListeners() {
        // Runs once: the filters toggle can bind these before initializeFullProjectView() does
        if (this.eventListenersBound) return;
        this.eventListenersBound = true;

        // Token management
        this.setupTokenEventListeners();

        // Filters
        document.getElementById('repoFilter').addEventListener('change', async (e) => {
            const selectedValue = e.target.value;

            // Handle special load_all option
            if (selectedValue === 'load_all') {
                await this.loadAllRepositories();
                // Reset to the current filter after loading
                e.target.value = this.filters.repo;
                return;
            }


            // Warn user about rate limits when selecting "All Loaded Issues" without token
            if (selectedValue === 'all' && !this.githubToken) {
                const remaining = this.rateLimitInfo.remaining || 60; // Default rate limit without token
                const warning = `⚠️ Warning: Loading all repositories without a GitHub token may exhaust your remaining ${remaining} API requests.\n\nEnter your GitHub Token above for more robust requests (5,000/hour vs 60/hour).\n\nProceed anyway?`;

                if (!confirm(warning)) {
                    // Reset to projects if user cancels
                    e.target.value = 'projects';
                    this.filters.repo = 'projects';
                    return;
                }
            }

            this.filters.repo = selectedValue;
            this.updateHash();
            this.saveToCache();

            // Load issues for the selected repository if not already loaded
            if (this.filters.repo !== 'all' && !this.repositoryIssues[this.filters.repo]) {
                // Check if repository exists in our list, if not try to Add it dynamically
                const repoExists = this.repositories.find(r => r.name === this.filters.repo);
                if (!repoExists) {
                    try {
                        await this.addRepositoryDynamically(this.filters.repo);
                    } catch (error) {
                        console.error(`Failed to Add repository ${this.filters.repo}:`, error);
                        this.showNotification(`Repository "${this.filters.repo}" not found or has no issues`, 'error');
                        // Reset to projects repo
                        this.filters.repo = 'projects';
                        e.target.value = 'projects';
                        return;
                    }
                }

                await this.loadIssuesForRepository(this.filters.repo);
                this.updateRepositoryDropdownCounts();
            } else if (this.filters.repo === 'all') {
                // Load all repositories that haven't been loaded yet
                const unloadedRepos = this.repositories.filter(repo => !this.repositoryIssues[repo.name]);
                for (const repo of unloadedRepos) {
                    await this.loadIssuesForRepository(repo.name);
                }
                this.updateRepositoryDropdownCounts();
            }

            this.filterAndDisplayIssues();
        });

        // Dropdown menus
        this.setupDropdown('sortButton', 'sortDropdown', (value) => {
            this.filters.sort = value;
            this.updateSortButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        this.setupDropdown('assigneeButton', 'assigneeDropdown', (value) => {
            this.filters.assignee = value;
            this.updateAssigneeButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        this.setupDropdown('stateButton', 'stateDropdown', async (value) => {
            const previousState = this.filters.projectstatus;
            this.filters.projectstatus = value;
            this.updateStateButton();
            this.updateHash();
            this.saveToCache();

            // If state changed, clear memory cache and reload issues with new state
            if (previousState !== value) {
                this.repositoryIssues = {}; // Clear all cached issues

                // Reload issues for current repository with new state
                if (this.filters.repo !== 'all') {
                    await this.loadIssuesForRepository(this.filters.repo);
                } else {
                    await this.loadIssuesForAllRepositories();
                }
            }

            this.filterAndDisplayIssues();
        });

        this.setupDropdown('labelButton', 'labelDropdown', (value) => {
            this.filters.label = value;
            this.updateLabelButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        // Search
        const searchInput = document.getElementById('searchInput');
        const searchButton = document.getElementById('searchButton');
        const clearSearch = document.getElementById('clearSearch');

        searchButton.addEventListener('click', () => {
            this.performSearch();
            this.loadData(true); // Also refresh data like the old refresh button
        });
        clearSearch.addEventListener('click', () => this.clearSearch());
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.performSearch();
        });

        // Add debounced search on input
        searchInput.addEventListener('input', (e) => {
            this.debouncedSearch(e.target.value);
        });

        // Clear all filters button
        document.getElementById('clearAllFiltersBtn').addEventListener('click', () => {
            this.clearAllFilters();
        });

        // Clear cache button
        document.getElementById('clearCacheButton').addEventListener('click', () => {
            this.clearAllCache();
        });

        // Toggle filters button
        document.getElementById('toggleFiltersBtn').addEventListener('click', () => {
            this.toggleFilters();
        });

        // View controls
        document.getElementById('summaryView').addEventListener('click', () => this.setView('summary'));
        document.getElementById('listView').addEventListener('click', () => this.setView('list'));
        document.getElementById('cardView').addEventListener('click', () => this.setView('card'));

        // Filters expand/collapse - commented out (now using header search button instead)
        // document.getElementById('moreFiltersBtn').addEventListener('click', () => this.expandFilters());
        // document.getElementById('filtersCloseBtn').addEventListener('click', () => this.collapseFilters());

        // Modal
        document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
        document.getElementById('issueModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('issueModal')) this.closeModal();
        });

        // Refresh Dialog
        document.getElementById('refreshDialogClose').addEventListener('click', () => this.closeRefreshDialog());
        document.getElementById('refreshDialogCancel').addEventListener('click', () => this.closeRefreshDialog());
        document.getElementById('refreshDialogConfirm').addEventListener('click', () => this.confirmRefreshDialog());
        document.getElementById('refreshDialog').addEventListener('click', (e) => {
            if (e.target === document.getElementById('refreshDialog')) this.closeRefreshDialog();
        });

        // Retry button
        document.getElementById('retryButton').addEventListener('click', () => this.loadData(true));

        // Hash change listener with cache invalidation on filter changes
        window.addEventListener('hashchange', () => this.handleHashChange());

        // Resize listener to update width display
        window.addEventListener('resize', () => {
            this.updatePagination();
            this.updateAuthInstructionsCompactState();
        });
    }

    setupDropdown(buttonId, dropdownId, callback) {
        const button = document.getElementById(buttonId);
        const dropdown = document.getElementById(dropdownId);

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeAllDropdowns();
            dropdown.classList.toggle('show');
        });

        dropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.classList.contains('dropdown-item')) {
                const value = e.target.getAttribute('data-sort') ||
                    e.target.getAttribute('data-assignee') ||
                    e.target.getAttribute('data-state') ||
                    e.target.getAttribute('data-projectstatus') ||
                    e.target.getAttribute('data-label');
                callback(value);
                dropdown.classList.remove('show');
            }
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', () => {
            dropdown.classList.remove('show');
        });
    }

    closeAllDropdowns() {
        document.querySelectorAll('.dropdown-menu').forEach(dropdown => {
            dropdown.classList.remove('show');
        });
    }

    updateTokenUI() {
        const tokenInput = document.getElementById('githubToken');
        const clearButton = document.getElementById('clearToken');
        const addTokenButton = document.getElementById('addTokenButton');
        const saveButton = document.getElementById('saveToken');

        if (!tokenInput || !clearButton || !addTokenButton) {
            return;
        }

        if (this.githubToken) {
            tokenInput.value = '••••••••••••••••';
            clearButton.style.display = 'inline-block';
            tokenInput.style.display = 'inline-block';
            addTokenButton.style.display = 'none';
            if (saveButton) saveButton.style.display = '';
            this.tokenInputRevealed = true;
        } else {
            tokenInput.value = '';
            clearButton.style.display = 'none';
            tokenInput.style.display = 'inline-block';
            addTokenButton.style.display = 'none';
            // Auto-show auth section when no token exists
            const authSection = document.getElementById('authSection');
            if (authSection && authSection.style.display === 'none') {
                authSection.style.display = 'block';
                const toggleLink = document.getElementById('toggleTokenSection');
                if (toggleLink) toggleLink.style.display = 'none';
                const subtitleLine = document.getElementById('gitAccountHeaderRow');
                if (subtitleLine) subtitleLine.classList.add('token-editor-open');
                this.updateAuthInstructionsCompactState();
            }
            if (!this.saveTokenVisible) {
                if (saveButton) saveButton.style.display = 'none';
            }
        }
    }

    revealTokenInput() {
        const tokenInput = document.getElementById('githubToken');
        const addTokenButton = document.getElementById('addTokenButton');
        if (!tokenInput || !addTokenButton) return;

        this.tokenInputRevealed = true;
        this.saveTokenVisible = true;
        tokenInput.style.display = 'inline-block';
        addTokenButton.style.display = 'none';
        const saveButton = document.getElementById('saveToken');
        if (saveButton) saveButton.style.display = '';
        tokenInput.focus();
    }

    updateAuthInstructionsCompactState() {
        const headerContent = document.querySelector('.header-content');
        const authInstructions = document.querySelector('.auth-instructions');
        if (!headerContent || !authInstructions) return;

        const headerWidth = headerContent.getBoundingClientRect().width;
        authInstructions.classList.toggle('compact-actions', headerWidth <= 500);
    }

    updateViewStepsLinkLabel(details, link) {
        if (!details || !link) return;
        link.textContent = details.hasAttribute('open') ? 'Hide Steps' : 'View Steps';
    }

    maybeOpenAuthInstructionsForUpdateToken() {
        const headerContent = document.querySelector('.header-content');
        const authInstructionsDetails = document.querySelector('.auth-instructions details');
        const toggleTokenLink = document.getElementById('toggleTokenSection');
        if (!headerContent || !authInstructionsDetails || !toggleTokenLink) return;

        const headerWidth = headerContent.getBoundingClientRect().width;
        const isUpdateToken = toggleTokenLink.textContent.trim() === 'Update Token';
        if (isUpdateToken && headerWidth > 500) {
            authInstructionsDetails.setAttribute('open', '');
            const viewStepsLink = document.querySelector('.view-steps-link');
            if (viewStepsLink) {
                this.updateViewStepsLinkLabel(authInstructionsDetails, viewStepsLink);
            }
        }
    }

    toggleTokenSection() {
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');
        const toggleTokenLink = document.getElementById('toggleTokenSection');
        const subtitleLine = document.getElementById('gitAccountHeaderRow');

        if (authSection && authSection.style.display === 'none') {
            // Show the token section
            authSection.style.display = 'block';
            if (subtitleDescription) {
                subtitleDescription.style.display = 'block';
            }

            // Hide the add/update link and show close button in the same location.
            if (toggleTokenLink) {
                toggleTokenLink.style.display = 'none';
            }

            if (!document.getElementById('closeTokenSectionBtn')) {
                const closeBtn = document.createElement('button');
                closeBtn.id = 'closeTokenSectionBtn';
                closeBtn.className = 'icon-circle-btn close-token-btn';
                closeBtn.type = 'button';
                closeBtn.textContent = '\u2715';
                closeBtn.title = 'Close Token Section';
                closeBtn.onclick = () => this.toggleTokenSection();

                const gitAccountDisplay = document.getElementById('gitAccountDisplay');
                if (gitAccountDisplay && gitAccountDisplay.parentNode) {
                    gitAccountDisplay.parentNode.insertBefore(closeBtn, gitAccountDisplay.nextSibling);
                } else if (toggleTokenLink && toggleTokenLink.parentNode) {
                    toggleTokenLink.parentNode.insertBefore(closeBtn, toggleTokenLink.nextSibling);
                } else {
                    authSection.parentNode.appendChild(closeBtn);
                }
            }
            if (subtitleLine) {
                subtitleLine.classList.add('token-editor-open');
            }

            this.updateAuthInstructionsCompactState();
            this.maybeOpenAuthInstructionsForUpdateToken();
        } else if (authSection) {
            // Hide the token section
            authSection.style.display = 'none';
            if (subtitleDescription) {
                subtitleDescription.style.display = 'none';
            }

            if (toggleTokenLink) {
                toggleTokenLink.style.display = '';
            }

            // Remove inline close button
            const closeBtn = document.getElementById('closeTokenSectionBtn');
            if (closeBtn) {
                closeBtn.remove();
            }
            if (subtitleLine) {
                subtitleLine.classList.remove('token-editor-open');
            }
        }

        this.updateTokenSectionUI();
    }

    hideTokenSectionAndRestoreToggle() {
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');
        const toggleTokenLink = document.getElementById('toggleTokenSection');
        const closeBtn = document.getElementById('closeTokenSectionBtn');
        const subtitleLine = document.getElementById('gitAccountHeaderRow');

        if (authSection) authSection.style.display = 'none';
        if (subtitleDescription) subtitleDescription.style.display = 'none';
        if (toggleTokenLink) toggleTokenLink.style.display = '';
        if (closeBtn) closeBtn.remove();
        if (subtitleLine) subtitleLine.classList.remove('token-editor-open');
    }

    // Projects show when #projectsSectionsContainer is displayed without the filters-only class
    projectsListShown(projectsSections = document.getElementById('projectsSectionsContainer')) {
        return !!projectsSections && projectsSections.style.display !== 'none'
            && !projectsSections.classList.contains('filters-only');
    }

    async toggleProjectsSection() {
        const projectsSections = document.getElementById('projectsSectionsContainer');
        if (!projectsSections) return;

        if (this.projectsListShown(projectsSections)) {
            projectsSections.style.display = 'none';
            this.setProjectFiltersShown(false);
            this.updateTokenSectionUI();
            return;
        }

        // Viewing projects shows the filters with them, as before the filters toggle existed
        projectsSections.style.display = 'block';
        projectsSections.classList.remove('filters-only');
        this.setProjectFiltersShown(true);

        if (!this.projectsViewInitialized) {
            await this.initializeFullProjectView();
        }

        this.updateTokenSectionUI();
    }

    // Filters toggle beside View Projects. Before the project list is requested it shows the filters on their own
    // (filters-only), so choices made there are kept in this.filters and the hash, and apply when View Projects loads.
    toggleProjectFilters() {
        const projectsSections = document.getElementById('projectsSectionsContainer');
        if (!projectsSections) return;
        const show = !this.projectFiltersShown;
        if (show) this.setupEventListeners(); // Filter controls work before the list loads

        if (!this.projectsListShown(projectsSections)) {
            projectsSections.style.display = show ? 'block' : 'none';
            projectsSections.classList.toggle('filters-only', show);
        }
        this.setProjectFiltersShown(show);
        this.updateTokenSectionUI();
    }

    setProjectFiltersShown(show) {
        this.projectFiltersShown = show;
        document.getElementById('projectsSectionsContainer')?.classList.toggle('filters-hidden', !show);
        const btn = document.getElementById('toggleProjectFilters');
        if (btn) {
            btn.setAttribute('aria-pressed', String(show));
            btn.title = show ? 'Hide filters' : 'Show filters';
        }
    }

    showTokenSectionAndOpenTab() {
        // First scroll to top and reveal auth section
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');

        // Show the token section
        if (authSection) {
            authSection.style.display = 'block';
        }
        if (subtitleDescription) {
            subtitleDescription.style.display = 'block';
        }

        // Scroll to top smoothly to show the auth section
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });

        // Open the token URL in new tab immediately
        window.open('https://github.com/settings/tokens/new?description=ModelEarth+Projects+Hub&scopes=repo,read:org', '_blank');
    }

    updateTokenSectionUI() {
        const toggleLink = document.getElementById('toggleTokenSection');
        const projectsToggleLink = document.getElementById('toggleProjectsSection');
        const benefitText = document.getElementById('tokenBenefitText');
        const benefitDetail = document.getElementById('tokenBenefitDetail');
        const headerRefreshSpan = document.getElementById('headerLastRefreshTime');
        const headerFullscreenBtn = document.querySelector('.header-fullscreen-btn');
        const projectsSections = document.getElementById('projectsSectionsContainer');
        const authSection = document.getElementById('authSection');
        const getTokenLink = document.getElementById('getTokenLink');
        const headerContent = document.querySelector('.header-content');
        const authInstructionsDetails = document.querySelector('.auth-instructions details');
        const tokenEditorOpen = authSection && authSection.style.display !== 'none';
        const headerWidth = headerContent ? headerContent.getBoundingClientRect().width : Number.POSITIVE_INFINITY;
        const isNarrowHeader = headerWidth <= 500;
        const authStepsOpen = authInstructionsDetails ? authInstructionsDetails.hasAttribute('open') : false;

        if (this.githubToken) {
            toggleLink.textContent = 'Update Token';
            toggleLink.classList.add('btn-plain');
            let detailText = 'Your API limit increased from 60 to 5,000 requests per hour.';
            if (this.showTokenSource) {
                detailText += ` (Source: ${this.getTokenSourceLabel()})`;
            }

            // Add current request count and reset time if available
            if (this.rateLimitInfo.remaining !== null && this.rateLimitInfo.resetTime) {
                const resetTime = new Date(this.rateLimitInfo.resetTime);
                const resetTimeString = resetTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                detailText += ` ${this.rateLimitInfo.remaining} remain. Resets at ${resetTimeString}.`;
            } else if (this.rateLimitInfo.remaining !== null) {
                detailText += ` ${this.rateLimitInfo.remaining} remain.`;
            }

            if (benefitText) {
                if (benefitDetail) {
                    benefitDetail.textContent = detailText;
                }
                benefitText.style.display = 'flex';
            }
        } else {
            toggleLink.textContent = 'Add My Token';
            toggleLink.classList.remove('btn-plain');
            if (benefitText) {
                if (benefitDetail) {
                    benefitDetail.textContent = 'Add your token to increase API rate limits from 60 to 5,000 requests per hour';
                }
                benefitText.style.display = 'none';
            }
        }

        if (getTokenLink) {
            if (this.githubToken) {
                const showForNarrowUpdate = tokenEditorOpen && isNarrowHeader && !authStepsOpen;
                getTokenLink.style.display = showForNarrowUpdate ? '' : 'none';
            } else {
                getTokenLink.style.display = '';
            }
        }

        // Always keep refresh time info hidden (now sent to console)
        if (headerRefreshSpan) {
            headerRefreshSpan.style.display = 'none';
        }

        // Show View/Hide Projects only when project sections are hidden under the header.
        if (projectsToggleLink) {
            if (!this.showProject && projectsSections) {
                const isVisible = this.projectsListShown(projectsSections);
                // Hide beside the open token editor only while it shares the header row
                // (requests/engine moves it into its own Projects panel).
                const inHeaderRow = !!projectsToggleLink.closest('#gitAccountHeaderRow');
                if (tokenEditorOpen && inHeaderRow) {
                    projectsToggleLink.style.display = 'none';
                } else {
                    projectsToggleLink.style.display = 'inline-flex';
                    projectsToggleLink.textContent = isVisible ? 'Hide Projects' : 'View Projects';
                }
            } else {
                projectsToggleLink.style.display = 'none';
            }
        }

        // The filters toggle appears wherever View Projects does
        const projectFiltersToggle = document.getElementById('toggleProjectFilters');
        if (projectFiltersToggle && projectsToggleLink) {
            projectFiltersToggle.style.display = projectsToggleLink.style.display === 'none' ? 'none' : 'inline-flex';
        }

        // Hide fullscreen control when only auth/token editor is shown.
        if (headerFullscreenBtn) {
            const authOnlyView = !this.showProject && !this.projectsListShown(projectsSections);
            headerFullscreenBtn.style.display = authOnlyView ? 'none' : '';
        }

        // Update the refresh time display
        this.updateHeaderRefreshDisplay();
    }

    // Where the stored token came from, recorded in localStorage 'github_token_source'
    getTokenSourceLabel() {
        const source = localStorage.getItem('github_token_source');
        if (source === 'env') return '.env file, cached in browser';
        return 'browser cache';
    }

    async loadTokenFromAPI() {
        // If token already exists in localStorage, don't fetch from API
        if (this.githubToken) {
            return;
        }

        const allowLocalhostAccess = (typeof window.shouldAccessLocalhost == 'function')
            ? window.shouldAccessLocalhost()
            : (window.location.hostname == 'localhost' || window.location.hostname == '127.0.0.1');
        if (!allowLocalhostAccess) {
            return;
        }

        try {
            // Try to fetch token from Rust API server (reads the .env set by automation/paths.yaml)
            const response = await fetch('http://localhost:8081/api/github/token');

            if (response.ok) {
                const data = await response.json();
                if (data.token) {
                    // Store in localStorage so it persists and is shared across widgets
                    localStorage.setItem('github_token', data.token);
                    localStorage.setItem('github_token_source', 'env');
                    this.githubToken = data.token;
                    console.log('✅ GitHub token loaded from API (server .env)');
                } else {
                    console.log('ℹ️ No GitHub token available in server .env');
                }
            } else {
                console.log('ℹ️ API server not available or no token configured');
            }
        } catch (error) {
            // API not available or error - this is expected if server isn't running
            console.log('ℹ️ Could not load token from API:', error.message);
        }
    }

    async saveToken() {
        const tokenInput = document.getElementById('githubToken');
        const token = tokenInput.value.trim();

        if (token && token !== '••••••••••••••••') {
            // Validate token contains only ASCII characters (ISO-8859-1)
            // GitHub tokens should only contain alphanumeric characters and underscores
            if (!/^[\x00-\xFF]*$/.test(token)) {
                this.showNotification('Invalid token: Token contains non-ASCII characters. GitHub tokens should only contain letters, numbers, and basic symbols.', 'error');
                console.error('❌ Token validation failed: Contains non-ASCII characters');
                return;
            }

            this.githubToken = token;
            localStorage.setItem('github_token', token);
            localStorage.setItem('github_token_source', 'entered');
            localStorage.removeItem('github_issues_base_cache');
            localStorage.removeItem('github_issues_filtered_cache');
            localStorage.removeItem('github_all_repos');
            localStorage.removeItem('github_all_repos_time');
            this.clearRepositoryCache();

            // Clear rate limit info since new token likely has better limits
            this.clearRateLimit();

            // Clear any invalid token message and reset warning flags
            this.invalidTokenMessage = null;
            this.invalidTokenWarningShown = false;
            this.rateLimitWarningShown = false; // Reset rate limit warning when new token is added

            this.showNotification('Token saved successfully', 'success');

            // Check if issues previously failed due to rate limiting and refresh them
            await this.refreshIssuesAfterTokenSave();

            // Reload repositories with new token to populate all available repos
            try {
                await this.loadRepositoriesFromCSVToUI();
                this.populateRepositoryDropdown();
            } catch (error) {
                console.error('Error refreshing repositories after token save:', error);
            }
        }

        commitGitIssuesAccount({ allowEmpty: true });
        this.updateTokenUI();
        this.updateTokenSectionUI();
        this.hideTokenSectionAndRestoreToggle();
    }

    async refreshIssuesAfterTokenSave() {
        try {
            // Check if we currently have a rate limit exceeded state or error state
            const issuesList = document.getElementById('issuesList');
            const errorMessage = document.getElementById('errorMessage');
            const currentErrorMessage = issuesList ? issuesList.innerHTML : '';
            const hasErrorDisplay = errorMessage && errorMessage.style.display !== 'none';

            const hasRateLimitError = currentErrorMessage.includes('API Rate Limit Exceeded') ||
                currentErrorMessage.includes('rate limit') ||
                currentErrorMessage.includes('no-issues') ||
                hasErrorDisplay ||
                this.allIssues.length === 0;

            // Check if rate limit was previously exceeded (stored in rateLimitInfo)
            const wasRateLimited = this.rateLimitInfo.remaining === 0 ||
                localStorage.getItem('github_rate_limit_exceeded') === 'true';

            // Check if we have no repository data loaded due to rate limiting
            const hasNoRepoData = this.repositories.length === 0;

            if (hasRateLimitError || wasRateLimited || hasNoRepoData) {
                this.showNotification('Refreshing issues with new token...', 'info');

                // Clear any rate limit flags
                localStorage.removeItem('github_rate_limit_exceeded');

                // Force refresh the data now that we have a token
                await this.loadData(true);

                this.showNotification('Issues refreshed successfully!', 'success');
            } else {
            }
        } catch (error) {
            console.error('Error refreshing issues after token save:', error);
            this.showNotification('Issues refreshed, but some data may still be loading', 'warning');
        }
    }

    clearToken() {
        // Show confirmation dialog
        const confirmed = confirm(
            'Are you sure you want to clear your GitHub token?\n\n' +
            'This will:\n' +
            '• Remove your stored token\n' +
            '• Clear cached issue data\n' +
            '• Reduce API rate limit from 5,000 to 60 requests per hour\n\n' +
            'You can always Add your token back later.'
        );

        if (confirmed) {
            this.githubToken = '';
            this.tokenInputRevealed = false;
            this.saveTokenVisible = false;
            localStorage.removeItem('github_token');
            localStorage.removeItem('github_token_source');
            localStorage.removeItem('github_issues_base_cache');
            localStorage.removeItem('github_issues_filtered_cache');
            this.clearRepositoryCache();
            this.updateTokenUI();
            this.updateTokenSectionUI();
            this.showNotification('GitHub token cleared successfully', 'info');
            this.hideTokenSectionAndRestoreToggle();
        }
    }

    async loadData(forceRefresh = false) {
        try {
            this.showLoading(true);
            this.hideError();

            // Check cache first
            if (!forceRefresh) {
                const cached = this.loadFromCache();
                if (cached && cached.repositories && cached.repositories.length > 0 && cached.issues && cached.issues.length > 0) {
                    this.repositories = cached.repositories;

                    // Filter out any invalid issues from cached data
                    const validCachedIssues = cached.issues.filter(issue => this.isValidIssue(issue));
                    this.allIssues = validCachedIssues;

                    // Set initial last_refreshed timestamp for cached issues that don't have it
                    this.allIssues.forEach(issue => {
                        if (!issue.last_refreshed) {
                            issue.last_refreshed = new Date().toISOString();
                        }
                    });

                    // Rebuild assignees and labels from cached data
                    this.assignees = new Set();
                    this.labels = new Set();
                    this.allIssues.forEach(issue => {
                        if (issue.assignees && issue.assignees.length > 0) {
                            issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                        }
                        if (issue.labels && issue.labels.length > 0) {
                            issue.labels.forEach(label => this.labels.add(label.name));
                        }
                    });

                    this.updateUI();
                    this.showLoading(false);
                    return;
                }
            }

            this.updateLoadingStatus('Loading repositories...');
            await this.loadRepositoriesFromCSVToUI();

            // Load issues for repositories
            if (this.filters.repo !== 'all') {
                // Check if the repository exists in our list
                const repoExists = this.repositories.find(r => r.name === this.filters.repo);
                if (repoExists) {
                    this.updateLoadingStatus(`Loading issues for ${this.filters.repo}...`);
                    await this.loadIssuesForRepository(this.filters.repo);
                } else {
                    console.warn(`Repository ${this.filters.repo} not found in loaded repositories. Available:`, this.repositories.map(r => r.name));
                    // Reset to first available repository or 'projects' as fallback
                    if (this.repositories.length > 0) {
                        this.filters.repo = this.repositories[0].name;
                        this.updateLoadingStatus(`Loading issues for ${this.filters.repo}...`);
                        await this.loadIssuesForRepository(this.filters.repo);
                    }
                }
            } else {
                // Load issues for all repositories
                this.updateLoadingStatus('Loading issues for all repositories...');
                await this.loadIssuesForAllRepositories();
            }

            this.updateUI();
            this.saveToCache();
            this.showLoading(false);

        } catch (error) {
            console.error('Error loading data:', error);

            // Always load repositories from CSV even on API error
            try {
                await this.loadRepositoriesFromCSVToUI();
                this.showFiltersOnError();
            } catch (csvError) {
                this.showError('Failed to load repository data: ' + csvError.message);
            }

            this.showLoading(false);
        }
    }

    async loadRepositoriesFromCSVToUI() {
        // Try to load repositories from GitHub API first if we have a token
        let allRepos = null;
        if (this.githubToken) {
            // Load only ModelEarth repositories that have at least one issue
            allRepos = await this.loadRepositoriesWithIssues();
            this.loadedAllRepositories = false;

            // Get total repository count for UI display
            try {
                this.totalRepositoryCount = await this.getRepositoryCount();
            } catch (error) {
                console.warn('Could not get total repository count:', error);
            }
        } else {
            // Without token, only load projects repo from CSV to avoid rate limiting

            // Initialize rate limit display for anonymous users (60 requests/hour)
            if (this.rateLimitInfo.remaining === null) {
                this.rateLimitInfo.remaining = 60; // GitHub's anonymous rate limit
                this.rateLimitInfo.resetTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
                this.updateRateLimitDisplay();
            }
        }

        if (allRepos && allRepos.length > 0) {
            // Use repositories with issues data (already in correct format)
            this.repositories = allRepos;
        } else {
            // Fallback to CSV data - but without token, only show projects repo to conserve rate limits
            const csvRepos = await this.loadRepositoriesFromCSV();

            if (!this.githubToken || this.invalidTokenMessage) {
                // Filter to only show projects repo to avoid exhausting rate limits
                // This includes both no token and invalid token cases
                const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
                if (projectsRepo) {
                    this.repositories = [{
                        name: projectsRepo.repo_name,
                        displayName: projectsRepo.display_name,
                        description: projectsRepo.description,
                        defaultBranch: projectsRepo.default_branch,
                        openIssueCount: null, // Will be loaded on demand
                        totalIssueCount: null,
                        repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`
                    }];

                    // Show cache notification on localhost
                    if (window.location.hostname === 'localhost') {
                        this.showNotification('Repository list loaded from browser cache (localhost)', 'info');
                    }
                } else {
                    console.warn('Projects repo not found in CSV');
                    this.repositories = [];
                }
                this.loadedAllRepositories = false; // Don't load all without valid token
            } else {
                // With valid token but loadRepositoriesWithIssues failed/returned empty
                // This should not happen - fall back to projects repo only for safety
                console.warn('loadRepositoriesWithIssues returned empty - falling back to projects repo only');
                const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
                if (projectsRepo) {
                    this.repositories = [{
                        name: projectsRepo.repo_name,
                        displayName: projectsRepo.display_name,
                        description: projectsRepo.description,
                        defaultBranch: projectsRepo.default_branch,
                        openIssueCount: null, // Will be loaded on demand
                        totalIssueCount: null,
                        repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`
                    }];
                } else {
                    this.repositories = [];
                }
                this.loadedAllRepositories = false;
            }
        }

        // Set projects as default selection if no specific repo is set
        if (this.githubToken && (this.filters.repo === 'modelearth' || this.filters.repo === 'all')) {
            this.filters.repo = 'projects';
        }

        // Start lazy loading: first load projects repo issues, then others in background
        if (this.githubToken) {
            await this.startLazyLoading();
        } else {
            // Only load issue counts for repositories we're actually showing
            // This prevents burning through API requests for repos not in the dropdown
            await this.loadRepositoryIssueCountsForDisplayed();
        }
    }

    async startLazyLoading() {

        // Step 1: Immediately load and display projects repo issues
        const projectsRepo = this.repositories.find(r => r.name === 'projects');
        if (projectsRepo && this.filters.repo === 'projects') {
            try {
                await this.loadIssuesForRepository('projects');
                this.updateRepositoryDropdownCounts();
                this.filterAndDisplayIssues();

                // Show immediate feedback to user
                this.showNotification('Projects issues loaded. Loading other repositories in background...', 'info');
            } catch (error) {
                console.error('Error loading projects repo:', error);
            }
        }

        // Step 2: Start background loading of other repositories
        setTimeout(() => this.lazyLoadOtherRepositories(), 100);
    }

    async lazyLoadOtherRepositories() {

        // Get repositories sorted by priority (projects first, others second)
        const otherRepos = this.repositories
            .filter(r => r.name !== 'projects')
            .sort((a, b) => (a.priority || 2) - (b.priority || 2));

        let loadedCount = 1; // projects already loaded

        for (const repo of otherRepos) {
            try {
                // Add small delay between loads to prevent overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 200));

                await this.loadIssuesForRepository(repo.name);
                loadedCount++;

                // Update UI progressively
                this.updateRepositoryDropdownCounts();

                // Update progress in console

            } catch (error) {
            }
        }

        this.showNotificationAboveIssues(`All ${loadedCount} repositories loaded successfully`, 'success');
    }

    async addRepositoryDynamically(repoName) {

        // First check if it exists in the full CSV list
        const csvRepos = await this.loadRepositoriesFromCSV();
        const csvRepo = csvRepos.find(repo => repo.repo_name === repoName);

        if (!csvRepo) {
            throw new Error(`Repository ${repoName} not found in ModelEarth organization`);
        }

        // Check if it has any open issues
        try {
            const openCount = await this.getRepositoryIssueCount(repoName, 'open');

            if (openCount === 0) {
                throw new Error(`Repository ${repoName} has no open issues`);
            }

            // Add to repositories list
            this.repositories.push({
                name: csvRepo.repo_name,
                displayName: csvRepo.display_name,
                description: csvRepo.description,
                defaultBranch: csvRepo.default_branch,
                openIssueCount: openCount,
                totalIssueCount: null, // Will be determined when issues are loaded
                repository_url: `https://github.com/${this.owner}/${csvRepo.repo_name}`,
                priority: 3 // Lower priority for dynamically added repos
            });

            // Update dropdown
            this.populateRepositoryFilter();

            this.showNotification(`Added repository "${repoName}" with ${openCount} open issues`, 'success');

        } catch (error) {
            throw new Error(`Repository ${repoName} not accessible or has no issues`);
        }
    }

    async loadRepositoryIssueCountsForDisplayed() {
        // Only load issue counts for repositories that are actually in our dropdown
        // This prevents burning through API requests for repositories not shown to users
        const reposToLoad = this.repositories.map(repo => repo.name);

        if (reposToLoad.length === 0) {
            return;
        }


        const cacheKey = `repo_issue_counts_${reposToLoad.join('_')}`;
        const cacheTimeKey = `repo_issue_counts_${reposToLoad.join('_')}_time`;

        // Check cache first (valid for 5 minutes)
        const cachedCounts = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCounts && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

            if (age < fiveMinutes) {
                this.repositoryIssueCounts = JSON.parse(cachedCounts);
                this.lastRefreshTime = new Date(parseInt(cacheTime));
                this.updateRepositoryDropdown();
                this.updateHeaderRefreshDisplay();
                return;
            }
        }

        try {
            this.lastRefreshTime = new Date();
            const counts = {};

            for (const repoName of reposToLoad) {
                try {
                    const openCount = await this.getRepositoryIssueCount(repoName, 'open');
                    const closedCount = await this.getRepositoryIssueCount(repoName, 'closed');

                    counts[repoName] = {
                        open: openCount,
                        closed: closedCount,
                        total: openCount + closedCount
                    };

                } catch (error) {
                    console.warn(`Error loading issue counts for ${repoName}:`, error);
                    // Continue with other repositories
                }
            }

            this.repositoryIssueCounts = counts;

            // Cache the results with repo-specific key
            localStorage.setItem(cacheKey, JSON.stringify(counts));
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            this.updateRepositoryDropdown();
            this.updateHeaderRefreshDisplay();
        } catch (error) {
            console.error('Error loading repository issue counts for displayed repos:', error);
        }
    }

    async loadAllRepositoryIssueCounts() {
        const cacheKey = 'repo_issue_counts';
        const cacheTimeKey = 'repo_issue_counts_time';

        // Check cache first (valid for 5 minutes)
        const cachedCounts = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCounts && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

            if (age < fiveMinutes) {
                this.repositoryIssueCounts = JSON.parse(cachedCounts);
                this.lastRefreshTime = new Date(parseInt(cacheTime));
                this.updateRepositoryDropdown();
                this.updateHeaderRefreshDisplay(); // Ensure display is updated
                return;
            }
        }

        // Load fresh issue counts
        try {
            const counts = {};

            for (const repo of this.repositories) {
                try {
                    const openCount = await this.getRepositoryIssueCount(repo.name, 'open');
                    const closedCount = await this.getRepositoryIssueCount(repo.name, 'closed');
                    counts[repo.name] = {
                        open: openCount,
                        closed: closedCount,
                        total: openCount + closedCount
                    };
                } catch (error) {
                    console.error(`Error loading issue count for ${repo.name}:`, error);
                    counts[repo.name] = { open: 0, closed: 0, total: 0 };
                }
            }

            this.repositoryIssueCounts = counts;
            this.lastRefreshTime = new Date();

            // Cache the results
            localStorage.setItem(cacheKey, JSON.stringify(counts));
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            this.updateRepositoryDropdown();
            this.updateHeaderRefreshDisplay(); // Ensure display is updated
        } catch (error) {
            console.error('Error loading repository issue counts:', error);
        }
    }

    async getRepositoryIssueCount(repoName, state = 'open') {
        try {
            // GitHub's repository API open_issues_count includes both issues AND pull requests
            // We need to get actual issues only by fetching and filtering
            const issuesUrl = `${this.baseURL}/repos/${this.owner}/${repoName}/issues?state=${state}&per_page=100`;
            const response = await fetch(issuesUrl, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    ...(this.githubToken && { 'Authorization': `token ${this.githubToken}` })
                }
            });

            // Handle 401 Unauthorized - invalid token
            if (response.status === 401 && this.githubToken) {
                console.warn(`⚠️ Invalid token detected for ${repoName}. Retrying without authentication...`);

                // Show warning message once (not for every repo)
                if (!this.invalidTokenWarningShown) {
                    this.showInvalidTokenMessage('Invalid or expired GitHub token. Switching to unauthenticated access (60 requests/hour).');
                    this.invalidTokenWarningShown = true;
                }

                // Clear the invalid token
                this.githubToken = null;
                localStorage.removeItem('github_token');
                localStorage.removeItem('github_token_source');
                this.clearRateLimit();
                this.updateTokenUI(); // Update UI to reflect cleared token

                // Retry without authentication
                const retryResponse = await fetch(issuesUrl, {
                    headers: {
                        'Accept': 'application/vnd.github.v3+json'
                    }
                });

                // Update rate limit info from retry response
                if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                    this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                    this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                    this.saveRateLimitToCache();
                    this.updateRateLimitDisplay();
                }

                if (retryResponse.ok) {
                    const issues = await retryResponse.json();
                    const actualIssues = issues.filter(item => !item.pull_request);
                    return actualIssues.length;
                }
                return 0;
            }

            // Handle 403 Forbidden - rate limit exceeded
            if (response.status === 403) {
                const errorData = await response.json().catch(() => ({}));

                // Update rate limit info from response headers
                if (response.headers.get('X-RateLimit-Remaining')) {
                    this.rateLimitInfo.remaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                    this.saveRateLimitToCache();
                    this.updateRateLimitDisplay();
                }

                // Show rate limit warning once (not for every repo)
                if (!this.rateLimitWarningShown) {
                    const resetTime = this.rateLimitInfo.resetTime ?
                        new Date(this.rateLimitInfo.resetTime).toLocaleTimeString() : 'soon';

                    this.showError(`Rate limit exceeded. ${errorData.message || 'Please wait until ' + resetTime + ' or Add a GitHub token for higher limits.'}`);
                    console.error(`❌ Rate limit exceeded for ${repoName}. Reset time: ${resetTime}`);
                    this.rateLimitWarningShown = true;
                }

                return 0;
            }

            if (response.ok) {
                const issues = await response.json();
                // Filter out pull requests - GitHub issues API returns both issues and PRs
                // Pull requests have a 'pull_request' property, actual issues don't
                const actualIssues = issues.filter(item => !item.pull_request);
                return actualIssues.length;
            }
            return 0;
        } catch (error) {
            console.error(`Error getting issue count for ${repoName}:`, error);
            return 0;
        }
    }

    async loadIssuesForAllRepositories() {

        for (const repo of this.repositories) {
            try {
                this.updateLoadingStatus(`Loading issues for ${repo.name}...`);
                await this.loadIssuesForRepository(repo.name);
            } catch (error) {
                console.error(`Error loading issues for ${repo.name}:`, error);
                // Continue with other repositories
            }
        }

    }

    async loadIssuesForRepository(repoName, forceRefresh = false) {
        // Check memory cache first
        if (!forceRefresh && this.repositoryIssues[repoName]) {
            return this.repositoryIssues[repoName];
        }

        // Check persistent cache for this repository with current state
        if (!forceRefresh) {
            const cachedData = this.loadRepositoryFromCache(repoName, this.filters.projectstatus);
            if (cachedData) {

                // Filter out any invalid issues from cached data
                const validCachedIssues = cachedData.issues.filter(issue => this.isValidIssue(issue));

                this.repositoryIssues[repoName] = validCachedIssues;

                // Update repository object with cached counts
                const repo = this.repositories.find(r => r.name === repoName);
                if (repo && cachedData.metadata) {
                    repo.openIssueCount = cachedData.metadata.openIssueCount;
                    repo.totalIssueCount = cachedData.metadata.totalIssueCount;
                }

                // Set initial last_refreshed timestamp for cached issues that don't have it
                cachedData.issues.forEach(issue => {
                    if (!issue.last_refreshed) {
                        issue.last_refreshed = new Date().toISOString();
                    }
                });

                // Update assignees and labels from cached data
                cachedData.issues.forEach(issue => {
                    if (issue.assignees && issue.assignees.length > 0) {
                        issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                    }
                    if (issue.labels && issue.labels.length > 0) {
                        issue.labels.forEach(label => this.labels.add(label.name));
                    }
                });

                // Add cached issues to allIssues if they aren't already there
                const existingIds = new Set(this.allIssues.map(issue => issue.id));
                const newCachedIssues = validCachedIssues.filter(issue => !existingIds.has(issue.id));
                this.allIssues.push(...newCachedIssues);

                return cachedData.issues;
            }
        }

        try {
            this.showNotification(`Loading issues for ${repoName}...`, 'info');
            const result = await this.fetchRepositoryIssues(repoName);
            const issues = result.issues;
            const apiResponse = result.apiResponse;

            this.repositoryIssues[repoName] = issues;

            // Update the repository object with issue counts
            const repo = this.repositories.find(r => r.name === repoName);
            if (repo) {
                const openIssues = issues.filter(issue => issue.state === 'open');

                // Special handling for projects repository: 0 issues likely means fetch failed
                if (repoName === 'projects' && issues.length === 0) {
                    console.warn(`⚠️ Projects repository returned 0 issues - likely fetch failed (projects should always have issues)`);
                    // Don't update counts to preserve any existing values or leave as null to indicate unknown state
                    repo.openIssueCount = null;
                    repo.totalIssueCount = null;
                } else {
                    repo.openIssueCount = openIssues.length;
                    repo.totalIssueCount = issues.length;
                }
            }

            // Add to allIssues if not already there
            const existingIssueIds = new Set(this.allIssues.map(issue => issue.id));
            const newIssues = issues.filter(issue => !existingIssueIds.has(issue.id));

            // Set initial last_refreshed timestamp for new issues
            newIssues.forEach(issue => {
                if (!issue.last_refreshed) {
                    issue.last_refreshed = new Date().toISOString();
                }
            });

            this.allIssues.push(...newIssues);

            // Collect assignees and labels
            issues.forEach(issue => {
                if (issue.assignees && issue.assignees.length > 0) {
                    issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                }
                if (issue.labels && issue.labels.length > 0) {
                    issue.labels.forEach(label => this.labels.add(label.name));
                }
            });

            this.populateAssigneeFilter();
            this.populateLabelFilter();

            // Save repository data to cache with API response metadata
            this.saveRepositoryToCache(repoName, issues, {
                openIssueCount: repo ? repo.openIssueCount : 0,
                totalIssueCount: repo ? repo.totalIssueCount : 0
            }, apiResponse, this.filters.projectstatus);

            return issues;
        } catch (error) {
            console.error(`Failed to load issues for ${repoName}:`, error);
            this.showNotification(`Failed to load issues for ${repoName}`, 'error');
            return [];
        }
    }

    updateRepositoryDropdownCounts() {
        const select = document.getElementById('repoFilter');
        const options = select.querySelectorAll('option');

        options.forEach(option => {
            const repoName = option.value;
            if (repoName !== 'all') {
                const repo = this.repositories.find(r => r.name === repoName);
                const displayName = repo?.displayName || repo?.name || repoName;

                if (repo) {
                    // Try different sources for issue count
                    let issueCount = null;

                    // First try to get from loaded issues
                    if (this.repositoryIssues[repoName]) {
                        const openIssues = this.repositoryIssues[repoName].filter(issue => issue.state === 'open');
                        issueCount = openIssues.length;
                    }
                    // Fall back to repository metadata
                    else if (repo.openIssueCount !== null) {
                        issueCount = repo.openIssueCount;
                    }
                    // Fall back to totalIssueCount for initial load
                    else if (repo.totalIssueCount !== null) {
                        issueCount = repo.totalIssueCount;
                    }

                    if (issueCount !== null) {
                        const issueText = `(${issueCount})`;
                        option.textContent = `${displayName} ${issueText}`;
                    } else {
                        // Only show (?) for projects if we really can't determine count
                        if (repoName === 'projects') {
                            option.textContent = `${displayName} (?)`;
                            option.title = 'Issue count unknown - fetch may have failed';
                        } else {
                            option.textContent = displayName;
                        }
                    }
                } else {
                    option.textContent = displayName;
                }
            }
        });
    }

    async enrichRepositoryData(repo) {
        try {
            // Get repository contents for file count and images
            const contents = await this.apiRequest(`/repos/${this.owner}/${repo.name}/contents`);
            repo.fileCount = contents.filter(item => item.type === 'file').length;

            // Look for images in common directories
            repo.images = [];
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'];

            // Check root directory
            const rootImages = contents.filter(item =>
                item.type === 'file' &&
                imageExtensions.some(ext => item.name.toLowerCase().endsWith(ext))
            );
            repo.images.push(...rootImages.slice(0, 4));

            // Check for common image directories if we need more images
            if (repo.images.length < 4) {
                const imageDirs = ['images', 'img', 'assets', 'static', 'public'];
                for (const dir of imageDirs) {
                    if (repo.images.length >= 4) break;
                    try {
                        const dirContents = await this.apiRequest(`/repos/${this.owner}/${repo.name}/contents/${dir}`);
                        const dirImages = dirContents.filter(item =>
                            item.type === 'file' &&
                            imageExtensions.some(ext => item.name.toLowerCase().endsWith(ext))
                        );
                        repo.images.push(...dirImages.slice(0, 4 - repo.images.length));
                    } catch (e) {
                        // Directory doesn't exist, continue
                    }
                }
            }

            // Get repository statistics
            const stats = await this.apiRequest(`/repos/${this.owner}/${repo.name}/stats/contributors`);
            repo.contributorCount = stats ? stats.length : 1;

        } catch (error) {
            console.warn(`Failed to enrich data for ${repo.name}:`, error);
            repo.fileCount = 0;
            repo.images = [];
            repo.contributorCount = 1;
        }
    }



    isValidIssue(issue) {
        // Check if issue has required fields and is not empty/invalid
        return issue &&
            typeof issue.id === 'number' &&
            typeof issue.number === 'number' &&
            typeof issue.title === 'string' &&
            issue.title.trim().length > 0 &&
            typeof issue.state === 'string' &&
            (issue.state === 'open' || issue.state === 'closed') &&
            issue.created_at &&
            issue.html_url;
    }

    async fetchRepositoryIssues(repoName) {
        const issues = [];
        let page = 1;
        let hasMore = true;
        let lastApiResponse = null; // Track the last successful API response for caching decisions

        // Determine what state to fetch based on current filter
        // Only fetch 'all' if user specifically wants closed or all issues
        const stateToFetch = this.filters.projectstatus === 'all' ? 'all' :
            this.filters.projectstatus === 'closed' ? 'closed' : 'open';


        while (hasMore) {
            try {
                const apiResult = await this.apiRequestWithMetadata(
                    `/repos/${this.owner}/${repoName}/issues?state=${stateToFetch}&per_page=100&page=${page}`
                );

                lastApiResponse = apiResult.metadata;
                const response = apiResult.data;

                if (response.length === 0) {
                    hasMore = false;
                } else {
                    // Filter out pull requests and invalid issues
                    const actualIssues = response.filter(issue => !issue.pull_request && this.isValidIssue(issue));

                    // Enrich each issue with additional data
                    for (const issue of actualIssues) {
                        issue.repository = repoName;
                        issue.repository_url = `https://github.com/${this.owner}/${repoName}`;

                        // Fetch comments if any
                        if (issue.comments > 0) {
                            try {
                                issue.comment_details = await this.apiRequest(
                                    `/repos/${this.owner}/${repoName}/issues/${issue.number}/comments`
                                );
                                console.log(`✅ Loaded ${issue.comment_details.length} comments for issue #${issue.number}`);
                            } catch (e) {
                                console.error(`❌ Failed to load comments for issue #${issue.number} (${issue.title}):`, e.message);
                                // Store error information for debugging
                                issue.comment_details = [];
                                issue.comment_load_error = e.message;
                            }
                        } else {
                            issue.comment_details = [];
                        }
                    }

                    issues.push(...actualIssues);
                    page++;
                }
            } catch (error) {
                console.error(`Error fetching issues for ${repoName}, page ${page}:`, error);

                // Capture error information for caching decisions
                if (error.response) {
                    lastApiResponse = {
                        status: error.response.status,
                        rateLimitRemaining: this.rateLimitInfo.remaining,
                        isError: true,
                        errorMessage: error.message
                    };
                }
                hasMore = false;
            }
        }

        // Return both issues and API response metadata for intelligent caching
        return { issues, apiResponse: lastApiResponse };
    }

    /**
     * Enhanced API request that returns both data and response metadata
     * for intelligent caching decisions
     */
    async apiRequestWithMetadata(endpoint) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
        };
        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }

        const response = await fetch(`${this.baseURL}${endpoint}`, { headers });

        // Extract rate limit information from headers
        let rateLimitRemaining = null;
        if (response.headers.get('X-RateLimit-Remaining')) {
            rateLimitRemaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
            this.rateLimitInfo.remaining = rateLimitRemaining;
            this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
            this.saveRateLimitToCache();
            this.updateRateLimitDisplay();
        }

        const metadata = {
            status: response.status,
            rateLimitRemaining: rateLimitRemaining,
            isError: false
        };

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));

            // Handle invalid token (401 Unauthorized)
            if (response.status === 401) {
                this.showInvalidTokenMessage(errorData.message || 'Invalid or expired GitHub token');

                // Automatically retry without token if we have an invalid token
                if (this.githubToken) {
                    console.warn('⚠️ Invalid token detected. Retrying without authentication...');
                    const tempToken = this.githubToken;
                    this.githubToken = null; // Temporarily clear token for retry
                    localStorage.removeItem('github_token');
                    this.clearRateLimit();
                    this.updateTokenUI(); // Update UI to reflect cleared token

                    try {
                        // Retry the same request without authentication
                        const retryHeaders = {
                            'Accept': 'application/vnd.github.v3+json',
                        };
                        const retryResponse = await fetch(`${this.baseURL}${endpoint}`, { headers: retryHeaders });

                        // Update rate limit info from retry response
                        if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                            this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                            this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                            this.saveRateLimitToCache();
                            this.updateRateLimitDisplay();
                        }

                        if (retryResponse.ok) {
                            console.log('✅ Successfully loaded data without authentication');
                            this.showNotification('Loaded data without authentication (60 requests/hour limit)', 'info');
                            const retryData = await retryResponse.json();
                            const retryMetadata = {
                                status: retryResponse.status,
                                rateLimitRemaining: this.rateLimitInfo.remaining,
                                isError: false
                            };
                            return { data: retryData, metadata: retryMetadata };
                        } else {
                            this.githubToken = tempToken;
                            const error = new Error(`GitHub API Error: ${retryResponse.status} - ${retryResponse.statusText}`);
                            error.response = metadata;
                            throw error;
                        }
                    } catch (retryError) {
                        this.githubToken = tempToken;
                        throw retryError;
                    }
                }

                const error = new Error(`GitHub API Error: ${response.status} - Invalid token`);
                error.response = metadata;
                throw error;
            }

            // Handle rate limit exceeded
            if (response.status === 403 && errorData.message && errorData.message.includes('rate limit')) {
                this.rateLimitInfo.startTime = new Date();
                this.rateLimitInfo.remaining = 0;
                if (response.headers.get('X-RateLimit-Reset')) {
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                }
                this.saveRateLimitToCache();
                this.updateRateLimitDisplay();
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            }

            const error = new Error(`GitHub API Error: ${response.status} - ${errorData.message || response.statusText}`);
            error.response = metadata;
            throw error;
        }

        const data = await response.json();
        return { data, metadata };
    }

    async apiRequest(endpoint) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
        };

        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }

        const response = await fetch(`${this.baseURL}${endpoint}`, { headers });

        // Extract rate limit information from headers
        if (response.headers.get('X-RateLimit-Remaining')) {
            this.rateLimitInfo.remaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
            this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
            this.saveRateLimitToCache();
            this.updateRateLimitDisplay();
        } else if (!this.githubToken) {
            // For anonymous users, assume default rate limit if headers not available
            // This happens when using cached data or when GitHub doesn't return headers
            if (this.rateLimitInfo.remaining === null) {
                this.rateLimitInfo.remaining = 60;
                this.rateLimitInfo.resetTime = new Date(Date.now() + 60 * 60 * 1000);
                this.updateRateLimitDisplay();
            }
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));

            // Handle invalid token (401 Unauthorized)
            if (response.status === 401) {
                this.showInvalidTokenMessage(errorData.message || 'Invalid or expired GitHub token');

                // Automatically retry without token if we have an invalid token
                if (this.githubToken) {
                    console.warn('⚠️ Invalid token detected. Retrying without authentication (60 requests/hour limit)...');
                    const tempToken = this.githubToken;
                    this.githubToken = null; // Temporarily clear token for retry

                    try {
                        // Retry the same request without authentication
                        const retryHeaders = {
                            'Accept': 'application/vnd.github.v3+json',
                        };
                        const retryResponse = await fetch(`${this.baseURL}${endpoint}`, { headers: retryHeaders });

                        // Update rate limit info from retry response
                        if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                            this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                            this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                            this.saveRateLimitToCache();
                            this.updateRateLimitDisplay();
                        }

                        if (retryResponse.ok) {
                            console.log('✅ Successfully loaded data without authentication');
                            // Keep token cleared since it's invalid
                            this.showNotification('Loaded data without authentication (60 requests/hour limit)', 'info');
                            return await retryResponse.json();
                        } else {
                            // Restore token for user to fix
                            this.githubToken = tempToken;
                            throw new Error(`GitHub API Error: ${retryResponse.status} - ${retryResponse.statusText}`);
                        }
                    } catch (retryError) {
                        // Restore token for user to fix
                        this.githubToken = tempToken;
                        throw retryError;
                    }
                }

                throw new Error(`GitHub API Error: ${response.status} - Invalid token`);
            }

            // Handle rate limit exceeded
            if (response.status === 403 && errorData.message && errorData.message.includes('rate limit')) {
                this.rateLimitInfo.startTime = new Date();
                this.rateLimitInfo.remaining = 0;
                if (response.headers.get('X-RateLimit-Reset')) {
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                }
                this.saveRateLimitToCache();
                this.updateRateLimitDisplay();

                // Flag that rate limit was exceeded for later token refresh detection
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            }

            throw new Error(`GitHub API Error: ${response.status} - ${errorData.message || response.statusText}`);
        }

        return await response.json();
    }

    updateProgress(current, total, type) {
        const percentage = Math.round((current / total) * 100);
        const progressBar = document.getElementById('progressBar');
        const loadingStatus = document.getElementById('loadingStatus');

        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
        }

        if (loadingStatus) {
            loadingStatus.textContent = `Processing ${current}/${total} ${type}...`;
        }
    }

    updateUI() {
        this.populateRepositoryFilter();
        this.populateAssigneeFilter();
        this.populateLabelFilter();
        this.updateStats();
        this.updateRateLimitDisplay();
        this.updateCacheStatusDisplay();
        this.filterAndDisplayIssues();

        // Update filter UI after repositories are loaded to ensure dropdown selections work
        this.updateFilterUI();

        // Clear rate limit exceeded flag if we successfully loaded data
        if (this.allIssues.length > 0 || this.repositories.length > 0) {
            localStorage.removeItem('github_rate_limit_exceeded');
        }

        // Keep filters hidden by default - user can toggle with search button
        // document.getElementById('filtersSection').style.display = 'block';
        document.getElementById('statsSection').style.display = 'flex';
        document.getElementById('issuesContainer').style.display = 'block';
    }

    populateRepositoryFilter() {
        const select = document.getElementById('repoFilter');

        // Calculate total for "All Repositories"
        let totalIssues = 0;
        if (this.repositoryIssueCounts) {
            totalIssues = Object.values(this.repositoryIssueCounts)
                .reduce((sum, counts) => sum + (counts.total || 0), 0);
        }

        const allReposText = totalIssues > 0 ? `All Loaded Issues (${totalIssues})` : 'All Loaded Issues';

        // Start with empty select
        select.innerHTML = '';

        // Sort repositories to put Projects first, then others, then All Repositories at the end
        const sortedRepos = [...this.repositories].sort((a, b) => {
            if (a.name === 'projects') return -1;
            if (b.name === 'projects') return 1;
            const aName = (a.displayName || a.name || '').toString();
            const bName = (b.displayName || b.name || '').toString();
            return aName.localeCompare(bName);
        });

        // Add individual repositories first (Projects will be at the top)
        sortedRepos.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.name;

            // Use cached issue counts if available
            const counts = this.repositoryIssueCounts[repo.name];
            let issueText = '';

            if (counts && counts.total > 0) {
                issueText = ` (${counts.total})`;
            } else if (repo.openIssueCount !== null) {
                issueText = ` (${repo.openIssueCount})`;
            } else if (repo.name === 'projects') {
                // Special indicator for projects repo when fetch failed
                issueText = ' (?)';
                option.title = 'Issue count unknown - fetch may have failed';
            }

            const repoName = repo.displayName || repo.name || 'Unknown';
            option.textContent = `${repoName}${issueText}`;
            select.appendChild(option);
        });

        // Add loading options based on repository and token status
        if (!this.loadedAllRepositories) {
            // Add separator
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            select.appendChild(separator);

            if (this.githubToken) {
                // Add currently loaded repos indicator
                const loadPrimaryOption = document.createElement('option');
                loadPrimaryOption.value = 'load_primary';
                const primaryCount = this.repositories.length;
                loadPrimaryOption.textContent = `Currently Loaded: ${primaryCount} Repos`;
                loadPrimaryOption.disabled = true; // Already loaded
                loadPrimaryOption.style.color = '#666';
                select.appendChild(loadPrimaryOption);

                // Add load all repos option
                const loadAllOption = document.createElement('option');
                loadAllOption.value = 'load_all';
                if (this.totalRepositoryCount !== null) {
                    loadAllOption.textContent = `Load All ${this.totalRepositoryCount} Repos`;
                } else {
                    loadAllOption.textContent = 'Load All Repos';
                }
                loadAllOption.style.fontStyle = 'italic';
                select.appendChild(loadAllOption);
            } else {
                // Without token, show option to load all but with warning
                const tokenHint = document.createElement('option');
                tokenHint.disabled = true;
                tokenHint.textContent = '⚠️ Add GitHub Token for full repo access';
                tokenHint.style.fontSize = '0.85em';
                tokenHint.style.color = '#dc3545';
                select.appendChild(tokenHint);
            }
        }

        // Add "All Repositories" option at the end
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = allReposText;
        select.appendChild(allOption);

        select.value = this.filters.repo;

        // If projects repo exists in the list, make sure it's selected when appropriate
        const projectsOption = Array.from(select.options).find(option => option.value === 'projects');
        if (projectsOption && this.filters.repo === 'projects') {
            select.value = 'projects';
        }
    }

    updateRepositoryDropdown() {
        // Update the dropdown with current issue counts
        this.populateRepositoryFilter();

        // Update the last refresh time display
        this.updateLastRefreshDisplay();
    }

    populateRepositoryDropdown() {
        // Alias for backwards compatibility
        this.updateRepositoryDropdown();
    }

    updateLastRefreshDisplay() {
        // This method is kept for backwards compatibility
        this.updateHeaderRefreshDisplay();
    }

    updateHeaderRefreshDisplay() {
        // Send refresh time to console instead of displaying on page
        if (this.lastRefreshTime) {
            const timeString = this.lastRefreshTime.toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } else {
        }

        // Keep the header refresh time display hidden
        const headerLastRefreshTime = document.getElementById('headerLastRefreshTime');
        if (headerLastRefreshTime) {
            headerLastRefreshTime.style.display = 'none';
        }
    }

    startAutoRefreshTimer() {
        // Don't start auto-refresh without a token to conserve rate limits
        if (!this.githubToken) {
            return;
        }

        // Clear existing timer
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }

        // Check every 5 minutes if we can refresh
        this.autoRefreshInterval = setInterval(async () => {
            const cacheTime = localStorage.getItem('repo_issue_counts_time');
            if (cacheTime) {
                const age = Date.now() - parseInt(cacheTime);
                const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

                if (age >= fiveMinutes) {
                    await this.loadAllRepositoryIssueCounts();
                }
            }
        }, 5 * 60 * 1000); // Check every 5 minutes
    }

    stopAutoRefreshTimer() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    }

    populateAssigneeFilter() {
        const dropdown = document.getElementById('assigneeDropdown');

        // Keep existing default options
        const defaultOptions = dropdown.innerHTML;
        dropdown.innerHTML = defaultOptions;

        // Add assignees
        Array.from(this.assignees).sort().forEach(assignee => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.setAttribute('data-assignee', assignee);
            item.innerHTML = `<i class="material-icons mi">person</i> ${assignee.split('-')[0]}`;
            dropdown.appendChild(item);
        });

        // Set default assignee based on gitAccount if available
        if (typeof updateAssigneeButtonDefault === 'function') {
            updateAssigneeButtonDefault();
        }
    }

    populateLabelFilter() {
        const dropdown = document.getElementById('labelDropdown');

        // Keep existing default options
        const defaultOptions = dropdown.innerHTML;
        dropdown.innerHTML = defaultOptions;

        // Add labels
        Array.from(this.labels).sort().forEach(label => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.setAttribute('data-label', label);
            item.innerHTML = `<i class="material-icons mi">label</i> ${label}`;
            dropdown.appendChild(item);
        });
    }

    updateStats() {
        const totalRepos = this.repositories.length;
        const openIssues = this.allIssues.filter(issue => issue.state === 'open').length;
        const closedIssues = this.allIssues.filter(issue => issue.state === 'closed').length;
        const totalComments = this.allIssues.reduce((sum, issue) => sum + (issue.comments || 0), 0);

        const repoCount = document.getElementById('repoCount');
        const openIssueCount = document.getElementById('openIssueCount');
        const closedIssueCount = document.getElementById('closedIssueCount');
        const totalCommentsCount = document.getElementById('totalComments');
        const activeProjectCount = document.getElementById('activeProjectCount');
        const pendingTaskCount = document.getElementById('pendingTaskCount');
        const dashboardOverview = document.getElementById('dashboardOverview');

        if (repoCount) repoCount.textContent = totalRepos;
        if (openIssueCount) openIssueCount.textContent = openIssues;
        if (closedIssueCount) closedIssueCount.textContent = closedIssues;
        if (totalCommentsCount) totalCommentsCount.textContent = totalComments;
        if (activeProjectCount) activeProjectCount.textContent = totalRepos;
        if (pendingTaskCount) pendingTaskCount.textContent = openIssues;
        const teamMemberCount = document.getElementById('teamMemberCount');
        if (teamMemberCount) teamMemberCount.textContent = '88';
        if (dashboardOverview) dashboardOverview.style.display = 'grid';
    }

    filterAndDisplayIssues() {

        let repositoryFilteredOut = 0;
        let statusFilteredOut = 0;
        let assigneeFilteredOut = 0;
        let labelFilteredOut = 0;
        let searchFilteredOut = 0;

        this.filteredIssues = this.allIssues.filter(issue => {
            // Repository filter
            if (this.filters.repo !== 'all' && issue.repository !== this.filters.repo) {
                repositoryFilteredOut++;
                return false;
            }

            // Project status filter
            if (this.filters.projectstatus !== 'all' && issue.state !== this.filters.projectstatus) {
                statusFilteredOut++;
                return false;
            }

            // Assignee filter
            if (this.filters.assignee !== 'all') {
                if (this.filters.assignee === 'unassigned') {
                    if (issue.assignees && issue.assignees.length > 0) return false;
                } else {
                    if (!issue.assignees || !issue.assignees.some(a => a.login === this.filters.assignee)) {
                        return false;
                    }
                }
            }

            // Label filter
            if (this.filters.label !== 'all') {
                if (!issue.labels || !issue.labels.some(l => l.name === this.filters.label)) {
                    return false;
                }
            }

            // Search filter
            if (this.filters.search) {
                const searchTerm = this.filters.search.toLowerCase();
                const searchableText = [
                    issue.title,
                    issue.body || '',
                    issue.number.toString(),
                    ...(issue.labels || []).map(l => l.name)
                ].join(' ').toLowerCase();

                if (!searchableText.includes(searchTerm)) {
                    return false;
                }
            }

            return true;
        });


        // Debug output

        if (this.filteredIssues.length === 0 && this.allIssues.length > 0) {
            console.warn('⚠️ All issues were filtered out! Check your filter settings.');
        }

        this.sortIssues();
        this.displayIssues();
        this.updateSearchStatus();

    }

    sortIssues() {
        this.filteredIssues.sort((a, b) => {
            switch (this.filters.sort) {
                case 'created':
                    return new Date(b.created_at) - new Date(a.created_at);
                case 'comments':
                    return (b.comments || 0) - (a.comments || 0);
                case 'title':
                    return (a.title || '').localeCompare(b.title || '');
                case 'number':
                    return a.number - b.number;
                case 'updated':
                default:
                    return new Date(b.updated_at) - new Date(a.updated_at);
            }
        });
    }

    displayIssues() {
        const issuesList = document.getElementById('issuesList');
        const startIndex = (this.currentPage - 1) * this.perPage;
        const endIndex = startIndex + this.perPage;
        const pageIssues = this.filteredIssues.slice(startIndex, endIndex);

        issuesList.innerHTML = '';
        // Row view: Summary shows collapsed 2-line rows; List and Card use their normal layouts
        if (this.rowView) {
            const isSummary = this.currentView === 'summary';
            issuesList.className = `issues-list ${this.currentView}-view${isSummary ? ' row-view' : ''}`;
            this.bindRowViewToggle(issuesList);
        }

        if (pageIssues.length === 0) {
            // Show token prompt if no token available, otherwise show regular no issues message
            if (!this.githubToken || this.invalidTokenMessage) {
                issuesList.innerHTML = `
                    <div class="no-issues">
                        <i class="material-icons mi">search</i>
                        <h3>Add your token</h3>
                        <p>Access more repositories and increase API rate limits</p>
                        <button class="btn btn-primary" onclick="issuesManager.showTokenSectionAndOpenTab()" style="margin-top: 10px;">
                            Get Your Token
                        </button>
                    </div>
                `;
            } else {
                issuesList.innerHTML = `
                    <div class="no-issues">
                        <i class="material-icons mi">search</i>
                        <h3>No issues found</h3>
                        <p>Try adjusting your filters or search terms.</p>
                    </div>
                `;
            }
        } else {
            pageIssues.forEach(issue => {
                const issueElement = this.createIssueElement(issue);
                issuesList.appendChild(issueElement);
            });
        }

        this.updatePagination();

        // Update Clear All Filters button visibility whenever filters are applied
        this.updateClearAllFiltersVisibility();
    }

    // Row view: click an issue's header to expand its details, or a comment to expand its text.
    // Links, buttons and the actions menu keep their own behavior. Bound once per list element.
    bindRowViewToggle(issuesList) {
        if (issuesList.dataset.rowViewBound) return;
        issuesList.dataset.rowViewBound = '1';
        issuesList.addEventListener('click', (event) => {
            if (!issuesList.classList.contains('row-view')) return; // Summary view only
            if (event.target.closest('a, button, input, textarea, select, .issue-actions-menu')) return;
            const comment = event.target.closest('.comment-item');
            if (comment) {
                comment.classList.toggle('expanded');
                return;
            }
            const header = event.target.closest('.issue-header');
            const item = header && header.closest('.issue-item');
            if (item) item.classList.toggle('expanded');
        });
    }

    createIssueElement(issue) {
        const issueDiv = document.createElement('div');
        issueDiv.className = 'issue-item';
        issueDiv.setAttribute('data-issue-id', issue.id);

        // Determine if we're showing multiple repositories
        const showingMultipleRepos = this.filters.repo === 'all' || this.repositoryIssueCounts && Object.keys(this.repositoryIssueCounts).length > 1;

        // Get current view type
        const currentView = this.currentView;

        const stateIcon = ''; // Remove state icons

        const assigneesHtml = issue.assignees && issue.assignees.length > 0 ?
            issue.assignees.map(assignee => `
                <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar" title="${assignee.login}"> 
                 <span >${assignee.login.split('-')[0].toLowerCase()}</span>
            `).join('') : '';

        const labelsHtml = issue.labels && issue.labels.length > 0 ?
            issue.labels.map(label => `
                <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                    ${label.name}
                </span>
            `).join('') : '';

        // Summary view content (always expanded details; collapsed to rows when rowView is on)
        if (currentView === 'summary') {
            const hideOwnerOnlyAssignee = this.shouldHideOwnerOnlyAssignee(issue);

            // Prepare detailed content
            const assigneesDetailHtml = issue.assignees && issue.assignees.length > 0 ?
                issue.assignees.map(assignee => `
                    <div class="assignee-detail">
                        <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar">
                        <span>${assignee.login.split('-')[0].toLowerCase()}</span>
                    </div>
                `).join('') : '<span class="text-muted">No assignees</span>';

            const labelsDetailHtml = issue.labels && issue.labels.length > 0 ?
                issue.labels.map(label => `
                    <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                        ${label.name}
                    </span>
                `).join('') : '';

            const commentsHtml = issue.comment_details && issue.comment_details.length > 0 ?
                issue.comment_details.map(comment => `
                    <div class="comment-item">
                        <div class="comment-header">
                            <img src="${comment.user.avatar_url}" alt="${comment.user.login}" class="comment-avatar">
                            <strong>${comment.user.login}</strong>
                            <span class="comment-date">${this.formatDate(comment.created_at)}</span>
                        </div>
                        <div class="comment-body">
                            ${this.formatMarkdown(comment.body)}
                        </div>
                    </div>
                `).join('') :
                issue.comment_load_error ?
                    `<p class="text-muted"><i class="material-icons mi">warning</i> Failed to load comments: ${issue.comment_load_error}. <a href="${issue.html_url}#issuecomment-section" target="_blank">View comments on GitHub</a></p>` :
                    '<p class="text-muted">No comments</p>';

            issueDiv.innerHTML = `
                <div class="issue-header">
                    <!-- Repo name and issue number line -->
                    <div class="issue-repo-line">
                        <a href="${issue.html_url}" target="_blank" class="repo-issue-link" title="Open in GitHub">
                            ${issue.repository.charAt(0).toUpperCase() + issue.repository.slice(1)} #${issue.number}
                        </a>

                        <!-- Issue Actions Menu -->
                        <div class="issue-actions-menu">
                            <button class="issue-menu-btn" onclick="issuesManager.toggleIssueMenu('${issue.id}', event)" title="Issue Actions">
                                <i class="material-icons mi">more_vert</i>
                            </button>
                            <div class="issue-menu-dropdown" id="issueMenu-${issue.id}">
                                <div class="menu-item" onclick="issuesManager.refreshSingleIssue('${issue.id}')">
                                    <i class="material-icons mi">sync</i> Refresh
                                </div>
                                <div class="menu-item" onclick="window.open('${issue.html_url}', '_blank')">
                                    <i class="material-icons mi">open_in_new</i> Open in GitHub
                                </div>
                                <div class="menu-item" onclick="issuesManager.copyIssueLink('${issue.html_url}')">
                                    <i class="material-icons mi">link</i> Copy Link
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Title -->
                    <h4 class="issue-title short-title">
                        #${issue.number} ${this.escapeHtml(issue.title)}
                    </h4>
                </div>

                <div class="issue-full-details" id="fullDetails-${issue.id}" style="display: block;">
                    <div class="issue-detail-inline">
                        <!-- Metadata Section -->
                        <div class="issue-meta-inline">
                            <span class="issue-date">
                                <i class="material-icons mi">add</i> Created: ${this.formatDate(issue.created_at)}
                            </span>
                            <span class="issue-date">
                                <i class="material-icons mi">schedule</i> Updated: ${this.formatDate(issue.updated_at)}
                            </span>
                            <span class="issue-date">
                                <i class="material-icons mi">sync</i> Last Refreshed:
                                <a href="#" onclick="issuesManager.showRefreshDialog('${issue.id}'); return false;" class="refresh-link" title="Click to refresh this issue">
                                    ${issue.last_refreshed ? this.formatFullDateTime(issue.last_refreshed) : this.formatFullDateTime(issue.created_at)}
                                </a>
                            </span>
                            ${issue.comments > 0 ? `
                                <span class="comment-count">
                                    <i class="material-icons mi">forum</i> ${issue.comments} comment${issue.comments > 1 ? 's' : ''}
                                </span>
                            ` : ''}
                        </div>

                        <!-- Description Section -->
                        ${issue.body ? `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Description</h5>
                                <div class="issue-description-full">
                                    ${this.renderSummaryDescription(issue)}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Labels Section -->
                        ${labelsDetailHtml.length > 0 ? `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Labels</h5>
                                <div class="issue-labels-detail">
                                    ${labelsDetailHtml}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Assignees Section (omitted when empty) -->
                        ${hideOwnerOnlyAssignee || !(issue.assignees && issue.assignees.length) ? '' : `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Assignees</h5>
                                <div class="assignees-detail">
                                    ${assigneesDetailHtml}
                                </div>
                            </div>
                        `}

                        <!-- Comments Section -->
                        ${issue.comments > 0 ? `
                            <div class="issue-section-inline comments-toggle-section">
                                <h5 class="section-title comments-toggle" role="button" tabindex="0" aria-expanded="false" onclick="issuesManager.toggleCommentsSection(this)" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.click(); }">
                                    Comments (${issue.comments}) <i class="material-icons mi comments-toggle-icon">expand_more</i>
                                </h5>
                                <div class="comments-section-inline">
                                    ${commentsHtml}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Action Buttons -->
                        <div class="issue-actions-inline">
                            <a href="${issue.html_url}" target="_blank" class="btn btn-primary btn-sm">
                                <svg class="mi-github" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View on GitHub
                            </a>
                            <a href="${issue.html_url}/edit" target="_blank" class="btn btn-secondary btn-sm">
                                <i class="material-icons mi">edit</i> Edit Issue
                            </a>
                        </div>
                    </div>
                </div>
            `;
            return issueDiv;
        }

        // List view and other views
        const repoInfo = this.repositories.find(r => r.name === issue.repository) || {};
        const repoImages = repoInfo.images && repoInfo.images.length > 0 ? `
            <div class="repo-images">
                ${repoInfo.images.slice(0, 2).map(img => `
                    <img src="${img.download_url}" alt="${img.name}" class="repo-image">
                `).join('')}
            </div>
        ` : '';

        issueDiv.innerHTML = `
            <div class="issue-header">
                <div class="issue-title-row">
                    <h4 class="issue-title">
                        <a href="${issue.html_url}" target="_blank">#${issue.number} ${this.escapeHtml(issue.title)}</a>
                    </h4>
                    
                    <!-- Issue Actions Menu -->
                    <div class="issue-actions-menu">
                        <button class="issue-menu-btn" onclick="issuesManager.toggleIssueMenu('${issue.id}', event)" title="Issue Actions">
                            <i class="material-icons mi">more_vert</i>
                        </button>
                        <div class="issue-menu-dropdown" id="issueMenu-${issue.id}">
                            <div class="menu-item" onclick="issuesManager.refreshSingleIssue('${issue.id}')">
                                <i class="material-icons mi">sync</i> Refresh
                            </div>
                            <div class="menu-item" onclick="window.open('${issue.html_url}', '_blank')">
                                <i class="material-icons mi">open_in_new</i> Open in GitHub
                            </div>
                            <div class="menu-item" onclick="issuesManager.copyIssueLink('${issue.html_url}')">
                                <i class="material-icons mi">link</i> Copy Link
                            </div>
                        </div>
                    </div>
                </div>
                <div class="issue-meta">
                    <span class="repo-name">
                        <i class="material-icons mi">call_split</i>
                        <a href="${issue.repository_url}" target="_blank">${issue.repository}</a>
                    </span>
                    <span class="issue-date">
                        <i class="material-icons mi">schedule</i>
                        Updated ${this.formatDate(issue.updated_at)}
                    </span>
                    ${issue.comments > 0 ? `
                        <span class="comment-count">
                            <i class="material-icons mi">forum</i>
                            ${issue.comments}
                        </span>
                    ` : ''}
                </div>
            </div>

            <div class="issue-body">
                ${issue.body ? `
                    <div class="issue-description">
                        ${this.formatMarkdown(issue.body.substring(0, 300))}
                        ${issue.body.length > 300 ? '...' : ''}
                    </div>
                ` : ''}
                
                ${labelsHtml ? `<div class="issue-labels">${labelsHtml}</div>` : ''}
                
                <div class="issue-footer">
                    <div class="issue-author">
                        <img src="${issue.user.avatar_url}" alt="${issue.user.login}" class="author-avatar">
                        <span>by ${issue.user.login.split("-")[0]}</span>          
                    </div>
                    
                    ${assigneesHtml ? `<div class="issue-assignees"> <span> Assigned To : </span> ${assigneesHtml}</div>` : ''}
                    
                    <div class="issue-actions">
                        <button class="btn btn-sm btn-outline" onclick="issuesManager.showIssueDetails(${issue.id})">
                            <i class="material-icons mi">visibility</i><span> Details</span>
                        </button>
                        <!-- GitHub button commented out - now available in 3-dot menu -->
                        <!--<a href="${issue.html_url}" target="_blank" class="btn btn-sm btn-outline">
                            <svg class="mi-github" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span> GitHub</span>
                        </a>-->
                    </div>
                </div>
                
                ${repoImages}
                
                <!-- Content for narrow card view (handled by CSS) -->
                
                ${!showingMultipleRepos && issue.body ? `
                    <div class="issue-body-preview">
                        ${this.formatMarkdown(issue.body.substring(0, 100))}${issue.body.length > 100 ? '...' : ''}
                    </div>
                ` : ''}
            </div>
        `;

        return issueDiv;
    }

    getRepoOwnerLogin(issue) {
        const fromApiUrl = issue.repository_url && issue.repository_url.match(/\/repos\/([^/]+)\//i);
        if (fromApiUrl && fromApiUrl[1]) {
            return fromApiUrl[1].toLowerCase();
        }

        const fromWebUrl = issue.html_url && issue.html_url.match(/github\.com\/([^/]+)\//i);
        if (fromWebUrl && fromWebUrl[1]) {
            return fromWebUrl[1].toLowerCase();
        }

        return (this.owner || '').toLowerCase();
    }

    shouldHideOwnerOnlyAssignee(issue) {
        if (!issue.assignees || issue.assignees.length !== 1) {
            return false;
        }
        const repoOwner = this.getRepoOwnerLogin(issue);
        const onlyAssignee = (issue.assignees[0].login || '').toLowerCase();
        return repoOwner && onlyAssignee === repoOwner;
    }

    renderSummaryDescription(issue) {
        if (!issue.body) {
            return '<span class="text-muted">No description provided</span>';
        }

        const fullBody = issue.body;
        const descriptionLimit = 750;
        if (fullBody.length <= descriptionLimit) {
            return this.formatMarkdown(fullBody);
        }

        const truncatedBody = fullBody.substring(0, descriptionLimit);
        return `
            <div id="issueDescPreview-${issue.id}">
                ${this.formatMarkdown(truncatedBody)}...
                <a href="#" class="more-link" onclick="issuesManager.toggleIssueDescription('${issue.id}', event); return false;">more</a>
            </div>
            <div id="issueDescFull-${issue.id}" style="display: none;">
                ${this.formatMarkdown(fullBody)}
                <div class="collapse-link-container">
                    <a href="#" class="less-link" onclick="issuesManager.toggleIssueDescription('${issue.id}', event); return false;">less</a>
                </div>
            </div>
        `;
    }

    toggleIssueDescription(issueId, event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        const issueItem = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (!issueItem) return;

        const preview = issueItem.querySelector(`#issueDescPreview-${issueId}`);
        const full = issueItem.querySelector(`#issueDescFull-${issueId}`);
        if (!preview || !full) return;

        const showingFull = full.style.display !== 'none';
        full.style.display = showingFull ? 'none' : 'block';
        preview.style.display = showingFull ? 'block' : 'none';
    }

    async showIssueDetails(issueId) {
        const issue = this.allIssues.find(i => i.id == issueId);
        if (!issue) return;

        const modal = document.getElementById('issueModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalBody = document.getElementById('modalBody');

        modalTitle.textContent = `${issue.title} #${issue.number}`;

        // Create detailed view
        const stateIcon = ''; // Remove state icons

        const assigneesHtml = issue.assignees && issue.assignees.length > 0 ?
            issue.assignees.map(assignee => `
                <div class="assignee-detail">
                    <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar">
                    <span >${assignee.login.split('-')[0].toLowerCase()}</span>
                </div>
            `).join('') : '<span class="text-muted">No assignees</span>';

        const labelsHtml = issue.labels && issue.labels.length > 0 ?
            issue.labels.map(label => `
                <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                    ${label.name}
                </span>
            `).join('') : '<span class="text-muted">No labels</span>';

        const commentsHtml = issue.comment_details && issue.comment_details.length > 0 ?
            issue.comment_details.map(comment => `
                <div class="comment-item">
                    <div class="comment-header">
                        <img src="${comment.user.avatar_url}" alt="${comment.user.login}" class="comment-avatar">
                        <strong>${comment.user.login}</strong>
                        <span class="comment-date">${this.formatDate(comment.created_at)}</span>
                    </div>
                    <div class="comment-body">
                        ${this.formatMarkdown(comment.body)}
                    </div>
                </div>
            `).join('') :
            issue.comment_load_error ?
                `<p class="text-muted"><i class="material-icons mi">warning</i> Failed to load comments: ${issue.comment_load_error}. <a href="${issue.html_url}#issuecomment-section" target="_blank">View comments on GitHub</a></p>` :
                '<p class="text-muted">No comments</p>';

        modalBody.innerHTML = `
            <div class="issue-detail">
                <div class="issue-header-detail">
                    ${stateIcon}
                    <div class="issue-meta-detail">
                        <div class="repo-info">
                            <i class="material-icons mi">call_split</i>
                            <a href="${issue.repository_url}" target="_blank">${issue.repository}</a>
                        </div>
                        <div class="issue-dates">
                            <div><i class="material-icons mi">add</i> Created: ${this.formatDate(issue.created_at)}</div>
                            <div><i class="material-icons mi">schedule</i> Updated: ${this.formatDate(issue.updated_at)}</div>
                            <div><i class="material-icons mi">sync</i> Last Refreshed: 
                                <a href="#" onclick="issuesManager.showRefreshDialog('${issue.id}'); return false;" class="refresh-link" title="Click to refresh this issue">
                                    ${issue.last_refreshed ? this.formatFullDateTime(issue.last_refreshed) : this.formatFullDateTime(issue.created_at)}
                                </a>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="issue-section">
                    <h4>Description</h4>
                    <div class="issue-description-full">
                        ${issue.body ? this.formatMarkdown(issue.body) : '<span class="text-muted">No description provided</span>'}
                    </div>
                </div>

                ${issue.labels && issue.labels.length ? `
                <div class="issue-section">
                    <h4>Labels</h4>
                    <div class="issue-labels-detail">
                        ${labelsHtml}
                    </div>
                </div>` : ''}

                ${issue.assignees && issue.assignees.length ? `
                <div class="issue-section">
                    <h4>Assignees</h4>
                    <div class="assignees-detail">
                        ${assigneesHtml}
                    </div>
                </div>` : ''}

                <div class="issue-section comments-toggle-section">
                    <h4 class="comments-toggle" role="button" tabindex="0" aria-expanded="false" onclick="issuesManager.toggleCommentsSection(this)" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.click(); }">
                        Comments (${issue.comments || 0}) <i class="material-icons mi comments-toggle-icon">expand_more</i>
                    </h4>
                    <div class="comments-section">
                        ${commentsHtml}
                    </div>
                </div>

                <div class="issue-actions-detail">
                    <a href="${issue.html_url}" target="_blank" class="btn btn-primary">
                        <svg class="mi-github" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View on GitHub
                    </a>
                    <a href="${issue.html_url}/edit" target="_blank" class="btn btn-secondary">
                        <i class="material-icons mi">edit</i> Edit Issue
                    </a>
                </div>
            </div>
        `;

        modal.style.display = 'flex';
    }

    // "Comments (n)" subtitle: show or hide that issue's comments (collapsed by default)
    toggleCommentsSection(toggle) {
        const section = toggle.closest('.comments-toggle-section');
        if (!section) return;
        const open = section.classList.toggle('comments-open');
        toggle.setAttribute('aria-expanded', String(open));
        const icon = toggle.querySelector('.comments-toggle-icon');
        if (icon) icon.textContent = open ? 'expand_less' : 'expand_more';
    }

    closeModal() {
        document.getElementById('issueModal').style.display = 'none';
    }

    showRefreshDialog(issueId) {
        this.currentRefreshIssueId = issueId;
        const issue = this.allIssues.find(i => i.id == issueId);
        if (!issue) return;

        document.getElementById('refreshDialogTitle').textContent = `Refresh Issue #${issue.number}`;
        document.getElementById('refreshDialog').style.display = 'flex';
    }

    closeRefreshDialog() {
        document.getElementById('refreshDialog').style.display = 'none';
        this.currentRefreshIssueId = null;
    }

    async confirmRefreshDialog() {
        if (this.currentRefreshIssueId) {
            // Store the ID before closing dialog (which sets it to null)
            const issueIdToRefresh = this.currentRefreshIssueId;

            // Close the refresh dialog
            this.closeRefreshDialog();

            // Refresh the issue
            await this.refreshSingleIssue(issueIdToRefresh);

            // Update the modal if it's still open
            const modal = document.getElementById('issueModal');
            if (modal.style.display !== 'none') {
                const issue = this.allIssues.find(i => i.id == issueIdToRefresh);
                if (issue) {
                    // Re-render the modal with updated data
                    this.showIssueDetails(issueIdToRefresh);
                }
            }
        }
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredIssues.length / this.perPage);
        const startIndex = (this.currentPage - 1) * this.perPage;
        const endIndex = Math.min(startIndex + this.perPage, this.filteredIssues.length);

        // Get container width for display
        const container = document.getElementById(this.containerId);
        const containerWidth = container ? container.offsetWidth : 0;

        // Update pagination info with width and fullscreen controls
        const paginationInfo = document.getElementById('paginationInfo');
        const fullscreenIcon = this.isFullscreen ? 'fullscreen_exit' : 'fullscreen';
        const headerFullscreenIcon = this.isFullscreen ? 'fullscreen_exit' : 'fullscreen';
        const fullscreenTitle = this.isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen';

        const leftText = this.filteredIssues.length === 0 ?
            'No issues found' :
            `Showing ${startIndex + 1}-${endIndex} of ${this.filteredIssues.length} issues (${this.perPage} per page)`;

        const rightText = `Widget width ${containerWidth}px <i class="material-icons mi fullscreen-btn" onclick="issuesManager.toggleFullscreen()" title="${fullscreenTitle}" style="margin-left: 0.5rem; cursor: pointer; color: var(--primary-color);">${fullscreenIcon}</i>`;

        paginationInfo.innerHTML = `<span class="pagination-left">${leftText}</span><span class="pagination-right" style="color: var(--text-muted); font-size: 0.85em;">${rightText}</span>`;

        // Update header fullscreen icon
        const headerIcon = document.querySelector('.header-fullscreen-btn');
        if (headerIcon) {
            headerIcon.className = 'material-icons header-fullscreen-btn';
            headerIcon.textContent = headerFullscreenIcon;
            headerIcon.title = fullscreenTitle;
        }

        // Update pagination controls
        const paginationControls = document.getElementById('paginationControls');
        paginationControls.innerHTML = '';

        if (totalPages <= 1) return;

        // Previous button
        const prevButton = document.createElement('button');
        prevButton.className = `pagination-btn ${this.currentPage === 1 ? 'disabled' : ''}`;
        prevButton.innerHTML = '<i class="material-icons mi">chevron_left</i>';
        prevButton.onclick = () => this.goToPage(this.currentPage - 1);
        paginationControls.appendChild(prevButton);

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            const pageButton = document.createElement('button');
            pageButton.className = `pagination-btn ${i === this.currentPage ? 'active' : ''}`;
            pageButton.textContent = i;
            pageButton.onclick = () => this.goToPage(i);
            paginationControls.appendChild(pageButton);
        }

        // Next button
        const nextButton = document.createElement('button');
        nextButton.className = `pagination-btn ${this.currentPage === totalPages ? 'disabled' : ''}`;
        nextButton.innerHTML = '<i class="material-icons mi">chevron_right</i>';
        nextButton.onclick = () => this.goToPage(this.currentPage + 1);
        paginationControls.appendChild(nextButton);
    }

    goToPage(page) {
        const totalPages = Math.ceil(this.filteredIssues.length / this.perPage);
        if (page < 1 || page > totalPages) return;

        this.currentPage = page;
        this.displayIssues();

        // Scroll to top of issues
        document.getElementById('issuesContainer').scrollIntoView({ behavior: 'smooth' });
    }

    // Utility methods
    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
        if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;

        return date.toLocaleDateString();
    }

    formatFullDateTime(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString();
    }

    formatMarkdown(text) {
        // Basic markdown formatting. Trimmed first: each newline becomes a <br>,
        // so trailing blank lines in an issue body showed as empty space below it.
        return String(text || '').trim()
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getContrastColor(hexColor) {
        // Convert hex to RGB
        const r = parseInt(hexColor.substr(0, 2), 16);
        const g = parseInt(hexColor.substr(2, 2), 16);
        const b = parseInt(hexColor.substr(4, 2), 16);

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    // State management
    updateHash() {
        const params = new URLSearchParams();
        Object.entries(this.filters).forEach(([key, value]) => {
            if (value && value !== 'all' && value !== '') {
                params.set(key, value);
            }
        });

        const newHash = params.toString();
        const currentHash = window.location.hash.substring(1);

        // Check if hash actually changed and clear cache if needed
        if (this.previousFilterHash !== null && newHash !== currentHash) {
            const filtersChanged = this.hasFiltersChanged(this.previousFilterHash, newHash);

            if (filtersChanged) {
                // Only clear filtered cache, preserve base cache
                localStorage.removeItem('github_issues_filtered_cache');

                // Clear repository-specific caches
                this.clearRepositoryCache();

                // Clear memory cache
                this.repositoryIssues = {};
            }
        }

        // Update the hash in URL
        const hashString = newHash ? `#${newHash}` : '';
        window.history.replaceState(null, null, window.location.pathname + hashString);

        // Update tracking for next comparison
        this.previousFilterHash = newHash;
    }

    // Extract filters from a hash string
    getFiltersFromHash(hashString) {
        const filters = {
            repo: this.defaultRepo,
            sort: 'updated',
            assignee: 'all',
            projectstatus: 'open',
            label: 'all',
            search: ''
        };

        if (!hashString) return filters;

        const params = new URLSearchParams(hashString);
        params.forEach((value, key) => {
            if (filters.hasOwnProperty(key)) {
                filters[key] = value;
            }
        });

        return filters;
    }

    // Create a normalized hash string from filters for comparison
    getFilterHash(filters) {
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([key, value]) => {
            if (value && value !== 'all' && value !== '') {
                params.set(key, value);
            }
        });
        return params.toString();
    }

    // Check if current filters are in default state (no filters applied)
    isDefaultFilterState() {
        return this.filters.sort === 'updated' &&
               this.filters.assignee === 'all' &&
               this.filters.projectstatus === 'open' &&
               this.filters.label === 'all' &&
               this.filters.search === '';
        // Note: repo filter is not checked as it's considered selection, not filtering
    }

    // Check if filters have changed between two hash states
    hasFiltersChanged(oldHash, newHash) {
        const oldFilters = this.getFiltersFromHash(oldHash);
        const newFilters = this.getFiltersFromHash(newHash);

        const filterKeys = ['repo', 'sort', 'assignee', 'projectstatus', 'label', 'search'];

        for (const key of filterKeys) {
            if (oldFilters[key] !== newFilters[key]) {
                return true;
            }
        }

        return false;
    }

    // Handle hash changes with cache invalidation for browser back/forward navigation
    async handleHashChange() {
        const currentHash = window.location.hash.substring(1);

        if (this.previousFilterHash !== null) {
            const filtersChanged = this.hasFiltersChanged(this.previousFilterHash, currentHash);

            if (filtersChanged) {
                // Only clear filtered cache, preserve base cache
                localStorage.removeItem('github_issues_filtered_cache');
                this.clearRepositoryCache();
                this.repositoryIssues = {};
            }
        }

        this.previousFilterHash = currentHash;
        await this.loadFromHash();
    }

    async loadFromHash() {
        const hash = window.location.hash.substring(1);
        if (!hash) return;

        const params = new URLSearchParams(hash);
        let customRepo = null;

        params.forEach((value, key) => {
            if (key === 'repo') {
                // Handle custom repository from URL hash
                customRepo = value;
                // Extract just the repo name for dropdown compatibility
                // For "modelearth/realitystream" → "realitystream"
                // For "realitystream" → "realitystream"  
                const repoName = value.includes('/') ? value.split('/')[1] : value;
                this.filters[key] = repoName;
            } else if (this.filters.hasOwnProperty(key)) {
                this.filters[key] = value;
            }
        });

        // If we have a custom repo from the hash, Add it to the repository list
        if (customRepo && customRepo !== 'all') {
            // Extract just the repo name for consistency
            const repoName = customRepo.includes('/') ? customRepo.split('/')[1] : customRepo;
            try {
                await this.addCustomRepositoryFromHash(repoName);
            } catch (error) {
                this.showNotification(`Repository "${repoName}" not found on ModelEarth GitHub. Please check the repository name.`, 'error');
                // Reset to 'all' filter to show available repositories
                this.filters.repo = 'all';
                this.updateFilterUI();
                return;
            }

            // Load issues for the selected repository if not already cached
            if (!this.repositoryIssues[this.filters.repo]) {
                try {
                    await this.loadIssuesForRepository(this.filters.repo);
                    this.updateRepositoryDropdownCounts();
                } catch (error) {
                    this.showNotification(`Repository "${this.filters.repo}" not found on ModelEarth GitHub. Please check the repository name.`, 'error');
                    // Reset to 'all' filter to show available repositories
                    this.filters.repo = 'all';
                    return;
                }
            }

            // Filter and display issues for the selected repository
            this.filterAndDisplayIssues();
        }

        this.updateFilterUI();
    }

    async addCustomRepositoryFromHash(repoName) {
        // Check if repository already exists in the list
        const existingRepo = this.repositories.find(r => r.name === repoName);
        if (existingRepo) {
            return; // Already exists
        }


        // If repo doesn't contain a slash, assume it's in the modelearth account
        const fullRepoPath = repoName.includes('/') ? repoName : `${this.owner}/${repoName}`;
        const [owner, repo] = fullRepoPath.split('/');

        try {
            // Try to fetch repository info from GitHub API
            if (this.githubToken) {
                const repoInfo = await this.apiRequest(`/repos/${owner}/${repo}`);

                // Add to repositories list
                this.repositories.push({
                    name: repo,
                    displayName: repoInfo.name,
                    description: repoInfo.description || '',
                    defaultBranch: repoInfo.default_branch || 'main',
                    openIssueCount: repoInfo.open_issues_count || null,
                    totalIssueCount: null,
                    repository_url: repoInfo.html_url
                });


                // Update the dropdown to include the new repository
                this.populateRepositoryFilter();

            } else {
                // No token - Add repository as placeholder
                this.repositories.push({
                    name: repo,
                    displayName: repo,
                    description: `Custom repository: ${fullRepoPath}`,
                    defaultBranch: 'main',
                    openIssueCount: null,
                    totalIssueCount: null,
                    repository_url: `https://github.com/${fullRepoPath}`
                });


                // Update the dropdown
                this.populateRepositoryFilter();
            }

        } catch (error) {

            // Don't Add non-existent repositories to avoid confusion
            // The error will be handled in the calling function
            throw new Error(`Repository "${fullRepoPath}" not found on GitHub`);
        }
    }

    updateFilterUI() {
        // Update filter dropdowns and inputs
        document.getElementById('repoFilter').value = this.filters.repo;
        document.getElementById('searchInput').value = this.filters.search;

        this.updateSortButton();
        this.updateAssigneeButton();
        this.updateStateButton();
        this.updateLabelButton();

        if (this.filters.search) {
            document.getElementById('clearSearch').style.display = 'inline-block';
        }
    }

    updateSortButton() {
        const button = document.getElementById('sortButton');
        const sortNames = {
            updated: 'Updated',
            created: 'Created',
            comments: 'Comments',
            title: 'Title',
            number: 'Number'
        };
        button.innerHTML = `
            <i class="material-icons mi">sort</i> Sort by: ${sortNames[this.filters.sort]}
            <i class="material-icons mi">expand_more</i>
        `;
    }

    updateAssigneeButton() {
        const button = document.getElementById('assigneeButton');
        let displayText = 'All';
        if (this.filters.assignee === 'unassigned') {
            displayText = 'Unassigned';
        } else if (this.filters.assignee !== 'all') {
            displayText = this.filters.assignee.split('-')[0];
        }

        // Check if container is narrow
        const container = button.closest('.filters-always-visible');
        const isNarrow = container && container.offsetWidth < 600;
        const labelText = isNarrow ? '' : 'Assigned to: ';

        button.innerHTML = `
            <i class="material-icons mi">person</i> ${labelText}${displayText}
            <i class="material-icons mi">expand_more</i>
        `;
    }

    updateStateButton() {
        const button = document.getElementById('stateButton');
        const stateNames = {
            open: 'Active',
            closed: 'Closed',
            all: 'All'
        };
        const displayText = stateNames[this.filters.projectstatus] || 'Active';
        button.innerHTML = `
            <i class="material-icons mi">error</i> ${displayText}
            <i class="material-icons mi">expand_more</i>
        `;
    }

    updateLabelButton() {
        const button = document.getElementById('labelButton');
        let displayText = this.filters.label === 'all' ? 'All' : this.filters.label;
        button.innerHTML = `
            <i class="material-icons mi">label</i> Labels: ${displayText}
            <i class="material-icons mi">expand_more</i>
        `;
    }

    saveToCache() {
        const cacheData = {
            filters: this.filters,
            repositories: this.repositories,
            issues: this.allIssues,
            timestamp: Date.now()
        };

        // Use separate cache for base (unfiltered) vs filtered results
        const isDefaultState = this.isDefaultFilterState();
        const cacheKey = isDefaultState ? 'github_issues_base_cache' : 'github_issues_filtered_cache';

        localStorage.setItem(cacheKey, JSON.stringify(cacheData));

        // Set up cache expiration timer for auto-refresh (only with token)
        if (this.cacheConfig.autoRefresh && this.githubToken) {
            this.setupCacheExpirationTimer(this.cacheConfig.duration * 60 * 1000);
        } else if (!this.githubToken) {
        }

        // Update cache status display
        this.updateCacheStatusDisplay();
    }

    saveViewPreference() {
        localStorage.setItem('github_issues_view', this.currentView);
    }

    loadViewPreference() {
        const savedView = localStorage.getItem('github_issues_view');
        const normalizedView = savedView === 'short' ? 'summary' : savedView;
        if (normalizedView && (normalizedView === 'summary' || normalizedView === 'list' || normalizedView === 'card')) {
            this.currentView = normalizedView;
            this.setView(normalizedView, false); // Don't save when loading
        }
    }

    toggleFullscreen() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        // In minimal mode (showProject=false), fullscreen the surrounding panel/card
        // so related page content remains visible instead of showing only the auth header.
        const fullscreenTarget = (!this.showProject && container.parentElement)
            ? (container.closest('.card') || container.closest('#contributionsPanel') || container)
            : container;

        this.isFullscreen = !this.isFullscreen;

        if (this.isFullscreen) {
            // Enter fullscreen
            fullscreenTarget.classList.add('widget-fullscreen');
            document.body.classList.add('widget-fullscreen-active');

            // Add minimize button to main header next to search icon
            const mainHeader = container.querySelector('.issues-header');
            if (mainHeader && !mainHeader.querySelector('.minimize-btn')) {
                const minimizeBtn = document.createElement('button');
                minimizeBtn.className = 'minimize-btn';
                minimizeBtn.innerHTML = '<span class="material-icons">fullscreen_exit</span>';
                minimizeBtn.title = 'Exit Fullscreen';
                minimizeBtn.onclick = () => this.toggleFullscreen();
                mainHeader.appendChild(minimizeBtn);
            }

        } else {
            // Exit fullscreen
            fullscreenTarget.classList.remove('widget-fullscreen');
            document.body.classList.remove('widget-fullscreen-active');

            // Remove minimize button
            const minimizeBtn = container.querySelector('.minimize-btn');
            if (minimizeBtn) {
                minimizeBtn.remove();
            }

        }

        // Update icon in pagination (only if showProject is true)
        if (this.showProject && typeof this.updatePagination === 'function') {
            this.updatePagination();
        }
    }

    toggleFilters() {
        const filtersSection = document.getElementById('filtersSection');
        const toggleBtn = document.querySelector('.toggle-filters-btn');
        const toggleText = document.querySelector('.toggle-text');

        if (!filtersSection) return;

        // Use the show-filters class instead of style.display to override !important CSS
        const isHidden = !filtersSection.classList.contains('show-filters');

        if (isHidden) {
            filtersSection.classList.add('show-filters');
            if (toggleBtn) toggleBtn.classList.add('active');
            if (toggleText) toggleText.textContent = 'Hide Filters';
        } else {
            filtersSection.classList.remove('show-filters');
            if (toggleBtn) toggleBtn.classList.remove('active');
            if (toggleText) toggleText.textContent = 'More Filters';
        }
    }

    hideFilters() {
        const filtersSection = document.getElementById('filtersSection');
        const toggleBtn = document.querySelector('.toggle-filters-btn');
        const toggleText = document.querySelector('.toggle-text');

        if (filtersSection) filtersSection.classList.remove('show-filters');
        if (toggleBtn) toggleBtn.classList.remove('active');
        if (toggleText) toggleText.textContent = 'More Filters';
    }

    // Issue menu functionality
    toggleIssueMenu(issueId, event) {
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }

        // Close all other open menus
        document.querySelectorAll('.issue-menu-dropdown').forEach(menu => {
            if (menu.id !== `issueMenu-${issueId}`) {
                menu.classList.remove('show');
            }
        });

        // Toggle current menu
        const menu = document.getElementById(`issueMenu-${issueId}`);
        if (menu) {
            menu.classList.toggle('show');
        }
    }

    async refreshSingleIssue(issueId) {
        try {
            // Close menu
            const menu = document.getElementById(`issueMenu-${issueId}`);
            if (menu) menu.classList.remove('show');

            // Find the issue in our current data
            const existingIssue = this.allIssues.find(issue => issue.id == issueId);
            if (!existingIssue) {
                this.showNotification('Issue not found', 'error');
                return;
            }

            // Show loading indicator on specific issue
            this.showIssueLoading(issueId, true);

            // Fetch fresh issue data from GitHub API
            const updatedIssue = await this.apiRequest(
                `/repos/${this.owner}/${existingIssue.repository}/issues/${existingIssue.number}`
            );

            // Preserve repository information
            updatedIssue.repository = existingIssue.repository;
            updatedIssue.repository_url = existingIssue.repository_url;

            // Update the issue in our data arrays
            this.updateIssueInCollections(updatedIssue);

            // Re-render only this specific issue
            this.rerenderSingleIssue(issueId, updatedIssue);

            // Update cache with new data
            this.saveToCache();

            this.showNotification(`Issue #${updatedIssue.number} refreshed`, 'success');

        } catch (error) {
            console.error('Error refreshing single issue:', error);
            if (error.name === 'AbortError') {
                this.showNotification('Refresh timed out', 'warning');
            } else if (error.message.includes('403')) {
                this.showNotification('API rate limit exceeded', 'error');
                // Flag that rate limit was exceeded for later token refresh detection
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            } else {
                this.showNotification('Failed to refresh issue', 'error');
            }
        } finally {
            this.showIssueLoading(issueId, false);
        }
    }

    expandIssueDetails(issueId, event) {
        // Prevent default link behavior
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        // Find the issue item by data attribute
        const issueItem = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (!issueItem) return;

        const fullDetailsDiv = issueItem.querySelector('.issue-full-details');
        const shortDescription = issueItem.querySelector('.short-description');

        if (fullDetailsDiv && shortDescription) {
            // Show full details inline
            fullDetailsDiv.style.display = 'block';
            shortDescription.style.display = 'none';
        }
    }

    collapseIssueDetails(issueId, event) {
        // Prevent default link behavior
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        // Find the issue item by data attribute
        const issueItem = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (!issueItem) return;

        const fullDetailsDiv = issueItem.querySelector('.issue-full-details');
        const shortDescription = issueItem.querySelector('.short-description');

        if (fullDetailsDiv && shortDescription) {
            // Hide full details and show short description
            fullDetailsDiv.style.display = 'none';
            shortDescription.style.display = 'block';
        }
    }

    updateIssueInCollections(updatedIssue) {
        // Add last refreshed timestamp
        updatedIssue.last_refreshed = new Date().toISOString();

        // Update in main issues array
        const mainIndex = this.allIssues.findIndex(issue => issue.id == updatedIssue.id);
        if (mainIndex !== -1) {
            this.allIssues[mainIndex] = updatedIssue;
        }

        // Update in filtered array if present
        const filteredIndex = this.filteredIssues.findIndex(issue => issue.id == updatedIssue.id);
        if (filteredIndex !== -1) {
            this.filteredIssues[filteredIndex] = updatedIssue;
        }

        // Update repository-specific cache if exists
        if (this.repositoryIssues[updatedIssue.repository]) {
            const repoIndex = this.repositoryIssues[updatedIssue.repository].findIndex(
                issue => issue.id == updatedIssue.id
            );
            if (repoIndex !== -1) {
                this.repositoryIssues[updatedIssue.repository][repoIndex] = updatedIssue;
            }
        }
    }

    rerenderSingleIssue(issueId, updatedIssue) {
        const existingElement = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (existingElement) {
            // Create new element with updated data
            const newElement = this.createIssueElement(updatedIssue);
            // Row view: keep the issue open if it was expanded
            newElement.classList.toggle('expanded', existingElement.classList.contains('expanded'));

            // Replace existing element with smooth transition
            existingElement.style.opacity = '0.5';

            setTimeout(() => {
                existingElement.replaceWith(newElement);
                newElement.style.opacity = '0';
                newElement.offsetHeight; // Force reflow
                newElement.style.transition = 'opacity 0.3s ease';
                newElement.style.opacity = '1';
            }, 150);
        }
    }

    showIssueLoading(issueId, isLoading) {
        const issueElement = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (issueElement) {
            if (isLoading) {
                issueElement.classList.add('issue-refreshing');
                // Add subtle loading indicator
                const loader = document.createElement('div');
                loader.className = 'issue-refresh-loader';
                loader.innerHTML = '<i class="material-icons mi mi-spin">sync</i>';
                issueElement.appendChild(loader);
            } else {
                issueElement.classList.remove('issue-refreshing');
                const loader = issueElement.querySelector('.issue-refresh-loader');
                if (loader) loader.remove();
            }
        }
    }

    async copyIssueLink(url) {
        try {
            await navigator.clipboard.writeText(url);
            this.showNotification('Issue link copied to clipboard', 'success');
        } catch (error) {
            console.error('Failed to copy link:', error);
            this.showNotification('Failed to copy link', 'error');
        }
    }

    // Close menus when clicking outside
    setupMenuClickHandler() {
        document.addEventListener('click', (event) => {
            // Check if click is outside any issue menu
            if (!event.target.closest('.issue-actions-menu')) {
                document.querySelectorAll('.issue-menu-dropdown').forEach(menu => {
                    menu.classList.remove('show');
                });
            }
        });
    }

    loadFromCache() {
        try {
            // Try to load from appropriate cache based on current filter state
            const isDefaultState = this.isDefaultFilterState();
            const cacheKey = isDefaultState ? 'github_issues_base_cache' : 'github_issues_filtered_cache';

            let cached = localStorage.getItem(cacheKey);

            // If no filtered cache exists but we have base cache, use base cache
            // This allows filters to work on top of cached base data
            if (!cached && !isDefaultState) {
                cached = localStorage.getItem('github_issues_base_cache');
            }

            if (!cached) return null;

            const data = JSON.parse(cached);

            // Check if cache is less than configured duration old
            const maxAge = this.cacheConfig.duration * 60 * 1000;
            const cacheAge = Date.now() - data.timestamp;
            if (cacheAge > maxAge) {
                // Remove expired cache
                localStorage.removeItem(cacheKey);
                return null;
            }

            if (data.filters) {
                this.filters = { ...this.filters, ...data.filters };
            }

            // Set up cache expiration timer if auto-refresh is enabled and we have a token
            if (this.cacheConfig.autoRefresh && this.githubToken) {
                this.setupCacheExpirationTimer(maxAge - cacheAge);
            } else if (!this.githubToken) {
            }

            return data;
        } catch (error) {
            console.warn('Failed to load from cache:', error);
            return null;
        }
    }

    // Repository-specific cache methods
    loadRepositoryFromCache(repoName, projectstatus = 'open') {
        try {
            const cacheKey = `github_repo_${repoName}_${projectstatus}_cache`;
            const cached = localStorage.getItem(cacheKey);
            if (!cached) return null;

            const data = JSON.parse(cached);

            // Check if cache is less than configured duration old
            const maxAge = this.cacheConfig.duration * 60 * 1000; // Convert minutes to milliseconds
            const cacheAge = Date.now() - data.timestamp;
            if (cacheAge > maxAge) {
                // Remove expired cache
                localStorage.removeItem(cacheKey);
                return null;
            }

            return data;
        } catch (error) {
            console.warn(`Failed to load repository ${repoName} from cache:`, error);
            return null;
        }
    }

    /**
     * DEFENSIVE CACHING IMPLEMENTATION - STRICT MODE
     * 
     * This function implements the requirement: "When there are no issues found, 
     * avoid saving any issues, so blank issues are not mistakes for saved actual 
     * issues when requests are available again."
     * 
     * KEY FEATURES:
     * 1. Always caches non-empty results (repositories with actual issues)
     * 2. NEVER caches empty results regardless of API status (strict defensive mode)
     * 3. Prevents false "no issues" states from being persisted in cache
     * 4. Stores API response metadata for debugging and future smart cache decisions
     * 
     * STRATEGY: Conservative approach - only cache when we have actual data
     * 
     * PREVENTS ALL SCENARIOS:
     * - Empty result from any cause → never cached → always fetches fresh on next request
     * - Ensures users always see real-time data when repositories actually have issues
     * - No risk of stale empty cache hiding legitimate issues
     */
    saveRepositoryToCache(repoName, issues, metadata, apiResponse = null, projectstatus = 'open') {
        try {
            // Defensive caching: Only cache when we're confident the data is legitimate
            const shouldCache = this.shouldCacheEmptyResult(issues, apiResponse);

            if (!shouldCache) {
                return;
            }

            const cacheKey = `github_repo_${repoName}_${projectstatus}_cache`;
            const cacheData = {
                issues: issues,
                metadata: metadata,
                timestamp: Date.now(),
                apiStatus: apiResponse ? {
                    status: apiResponse.status,
                    hasData: issues.length > 0,
                    rateLimitRemaining: apiResponse.rateLimitRemaining
                } : null
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (error) {
            console.warn(`Failed to save repository ${repoName} to cache:`, error);
        }
    }

    /**
     * Determines if empty results should be cached - STRICT DEFENSIVE MODE
     * NEVER caches empty results regardless of API status for maximum safety
     * 
     * STRICT POLICY - ALL SCENARIOS:
     * ✅ Cache: Non-empty results (repositories with actual issues) - ANY status
     * ❌ Don't Cache: Empty results (0 issues) - ALL statuses including 200 OK
     * 
     * REASONING: 
     * - Conservative approach prevents any false "no issues" cache states
     * - Always forces fresh API calls for empty results
     * - Eliminates risk of users missing legitimate issues due to cached empty states
     * - Better user experience at cost of slightly more API calls for empty repositories
     */
    shouldCacheEmptyResult(issues, apiResponse) {
        // If we have issues, always cache regardless of API status
        if (issues && issues.length > 0) {
            return true;
        }

        // STRICT DEFENSIVE MODE: NEVER cache empty results regardless of status
        return false;
    }


    clearRepositoryCache(repoName = null) {
        if (repoName) {
            // Clear cache for specific repository
            const cacheKey = `github_repo_${repoName}_cache`;
            localStorage.removeItem(cacheKey);
        } else {
            // Clear all repository caches
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith('github_repo_') && key.endsWith('_cache')) {
                    localStorage.removeItem(key);
                }
            });
        }
    }

    // Search functionality
    performSearch() {
        const searchInput = document.getElementById('searchInput');
        this.filters.search = searchInput.value.trim();
        this.currentPage = 1;
        this.updateHash();
        this.saveToCache();
        this.filterAndDisplayIssues();

        if (this.filters.search) {
            document.getElementById('clearSearch').style.display = 'inline-block';
        }
        this.updateSearchStatus();

    }



    clearSearch() {
        // clear the input + hide its X
        const input = document.getElementById('searchInput');
        const xBtn = document.getElementById('clearSearch');
        if (input) input.value = '';
        if (xBtn) xBtn.style.display = 'none';

        // wipe search & clear all filter buttons in one go
        this.filters.search = '';
        this.clearAllFilters();            // reuse existing logic

        // also hide the legacy "Clear All Filters" button permanently
        const oldClear = document.getElementById('clearAllFiltersBtn');
        if (oldClear) oldClear.style.display = 'none';
    }


    debouncedSearch(searchTerm) {
        // Clear previous timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Set new timer
        this.searchDebounceTimer = setTimeout(() => {
            this.filters.search = searchTerm.trim();
            this.currentPage = 1;
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();

            // Show/hide clear button
            const clearBtn = document.getElementById('clearSearch');
            if (this.filters.search) {
                clearBtn.style.display = 'inline-block';
            } else {
                clearBtn.style.display = 'none';
            }
        }, this.searchDebounceDelay);
        this.updateSearchStatus();

    }

    clearAllFilters() {
        // Clear the debounce timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Reset only filter buttons to default values (keep repo and search unchanged)
        this.filters.sort = 'updated';
        this.filters.assignee = 'all';
        this.filters.projectstatus = 'open';
        this.filters.label = 'all';

        // Update filter buttons
        this.updateSortButton();
        this.updateAssigneeButton();
        this.updateStateButton();
        this.updateLabelButton();

        // Reset pagination
        this.currentPage = 1;

        // Update URL and cache
        this.updateHash();
        this.saveToCache();

        // Apply filters
        this.filterAndDisplayIssues();

        // Show notification
        this.showNotification('Filter buttons cleared', 'info');

        // Update Clear All Filters button visibility
        this.updateClearAllFiltersVisibility();
        this.updateSearchStatus();

    }

    clearAllCache() {
        // Clear all cached repository issues
        this.repositoryIssues = {};
        this.repositoryIssueCounts = {};

        // Clear both base and filtered caches
        localStorage.removeItem('github_issues_base_cache');
        localStorage.removeItem('github_issues_filtered_cache');

        // Clear all other cache keys
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('github_repo_') || key.startsWith('github_issue_counts_')) {
                localStorage.removeItem(key);
            }
        });

        // Reset warning flags to allow fresh error messages
        this.rateLimitWarningShown = false;
        this.invalidTokenWarningShown = false;

        // Show notification
        this.showNotification('Cache cleared successfully', 'success');

        // Reload current repository data
        if (this.filters.repo && this.filters.repo !== 'all') {
            this.loadIssuesForRepository(this.filters.repo);
        } else {
            this.loadData(true);
        }
    }

    // Check if any filter buttons are different from defaults and show/hide Clear All Filters button
    updateClearAllFiltersVisibility() {
        const clearAllBtn = document.getElementById('clearAllFiltersBtn');
        if (!clearAllBtn) return;

        // Define default values for filter buttons only (excluding repo and search)
        const defaults = {
            sort: 'updated',
            assignee: 'all',
            projectstatus: 'open',
            label: 'all'
        };

        // Check if any filter button differs from default
        const hasNonDefaultFilters = Object.keys(defaults).some(key => {
            return this.filters[key] !== defaults[key];
        });

        // Show/hide the Clear All Filters button
        if (hasNonDefaultFilters) {
            clearAllBtn.style.display = 'inline-block';
        } else {
            clearAllBtn.style.display = 'none';
        }
    }

    // View management
    setView(viewType, savePreference = true) {
        if (viewType === 'short') {
            viewType = 'summary';
        }
        this.currentView = viewType;

        document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
        const activeViewButton = document.getElementById(viewType + 'View');
        if (activeViewButton) {
            activeViewButton.classList.add('active');
        }

        const issuesList = document.getElementById('issuesList');
        issuesList.className = `issues-list ${viewType}-view`;

        // Re-render issues with the new view
        this.displayIssues();

        // Save view preference to localStorage (unless loading from saved preference)
        if (savePreference) {
            this.saveViewPreference();
        }
    }

    // Filters expand/collapse management - commented out (now using header search button instead)
    /*
    expandFilters() {
        const filtersSection = document.getElementById('filtersSection');
        filtersSection.classList.add('expanded');
    }

    collapseFilters() {
        const filtersSection = document.getElementById('filtersSection');
        filtersSection.classList.remove('expanded');
    }
    */

    // UI helpers
    showLoading(show) {
        const issuesContainer = document.getElementById('issuesContainer');
        const issuesList = document.getElementById('issuesList');
        const loadingOverlay = document.getElementById('loadingOverlay');

        if (show) {
            // Show issues container and display loading inside it
            issuesContainer.style.display = 'block';
            issuesList.innerHTML = `
                <div class="loading-content">
                    <div class="spinner"></div>
                    <p>Loading GitHub data...</p>
                    <div class="loading-progress">
                        <div class="progress-bar" id="progressBar" style="width: 0%;"></div>
                    </div>
                    <p class="loading-status" id="loadingStatus">Fetching repositories...</p>
                </div>
            `;
            // Hide the overlay loading
            loadingOverlay.style.display = 'none';
        } else {
            // Hide the overlay loading (if it was showing)
            loadingOverlay.style.display = 'none';
            // Issues container will be managed by updateUI() method
        }
    }

    updateLoadingStatus(status) {
        document.getElementById('loadingStatus').textContent = status;
    }

    showError(message) {
        document.getElementById('errorMessage').style.display = 'block';
        document.getElementById('errorText').textContent = message;
        document.getElementById('filtersSection').style.display = 'none';
        document.getElementById('statsSection').style.display = 'none';
        document.getElementById('issuesContainer').style.display = 'none';
    }

    hideError() {
        document.getElementById('errorMessage').style.display = 'none';
    }

    showNotification(message, type = 'info') {
        // Check if this is a loading message that should be shown in issues container
        const isLoadingMessage = message.toLowerCase().includes('loading');

        if (isLoadingMessage) {
            // Show loading messages inside the issues container
            this.showInlineNotification(message, type);
        } else {
            // Show other notifications as floating (existing behavior)
            this.showFloatingNotification(message, type);
        }
    }

    showInlineNotification(message, type = 'info') {
        const issuesContainer = document.getElementById('issuesContainer');
        const issuesList = document.getElementById('issuesList');

        if (!issuesContainer || !issuesList) return;

        // Make sure issues container is visible
        issuesContainer.style.display = 'block';

        // Create notification element with subtle styling
        const notification = document.createElement('div');
        notification.className = `inline-notification ${type}`;

        // Use spinner for loading messages, other icons for other types
        const isLoadingMessage = message.toLowerCase().includes('loading');
        let iconHtml;

        if (isLoadingMessage) {
            iconHtml = '<i class="material-icons mi mi-spin inline-spinner">autorenew</i>';
        } else {
            const iconMap = {
                'success': 'check_circle',
                'error': 'warning',
                'info': 'info'
            };
            const icon = iconMap[type] || 'info';
            iconHtml = `<i class="material-icons mi">${icon}</i>`;
        }

        notification.innerHTML = `
            ${iconHtml}
            ${message}
        `;

        // Clear any existing inline notifications
        const existingNotification = issuesList.querySelector('.inline-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // Add to top of issues list
        issuesList.insertBefore(notification, issuesList.firstChild);

        // Auto-hide after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 3000);
    }

    // Inline notification placed just above #issuesContainer (falls back to floating)
    showNotificationAboveIssues(message, type = 'info') {
        const issuesContainer = document.getElementById('issuesContainer');
        if (!issuesContainer || !issuesContainer.parentNode) {
            this.showFloatingNotification(message, type);
            return;
        }

        const iconMap = {
            'success': 'check_circle',
            'error': 'warning',
            'info': 'info'
        };
        const icon = iconMap[type] || 'info';

        const existing = document.getElementById('issuesAboveNotification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.id = 'issuesAboveNotification';
        notification.className = `inline-notification ${type}`;
        notification.innerHTML = `
            <i class="material-icons mi">${icon}</i>
            ${message}
        `;
        issuesContainer.parentNode.insertBefore(notification, issuesContainer);

        // Auto-hide after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 3000);
    }

    showFloatingNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        const iconMap = {
            'success': 'check_circle',
            'error': 'warning',
            'info': 'info'
        };
        const icon = iconMap[type] || 'info';

        notification.innerHTML = `
            <i class="material-icons mi">${icon}</i>
            ${message}
        `;

        // Add to page
        document.body.appendChild(notification);

        // Show and auto-hide
        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    showFiltersOnError() {
        // Show basic UI elements even when API fails
        // Keep filters hidden by default - user can toggle with search button
        // document.getElementById('filtersSection').style.display = 'block';

        // Populate repository filter from loaded repositories
        this.populateRepositoryFilter();

        // Update rate limit display
        this.updateRateLimitDisplay();

        // Set basic stats
        const repoCount = document.getElementById('repoCount');
        const openIssueCount = document.getElementById('openIssueCount');
        const closedIssueCount = document.getElementById('closedIssueCount');
        const totalCommentsCount = document.getElementById('totalComments');
        const activeProjectCount = document.getElementById('activeProjectCount');
        const pendingTaskCount = document.getElementById('pendingTaskCount');
        const dashboardOverview = document.getElementById('dashboardOverview');

        if (repoCount) repoCount.textContent = '1';
        if (openIssueCount) openIssueCount.textContent = '?';
        if (closedIssueCount) closedIssueCount.textContent = '?';
        if (totalCommentsCount) totalCommentsCount.textContent = '?';
        if (activeProjectCount) activeProjectCount.textContent = '1';
        if (pendingTaskCount) pendingTaskCount.textContent = '?';
        const teamMemberCount = document.getElementById('teamMemberCount');
        if (teamMemberCount) teamMemberCount.textContent = '88';
        if (dashboardOverview) dashboardOverview.style.display = 'grid';

        // Show stats section
        document.getElementById('statsSection').style.display = 'flex';

        // Show issues container with message
        document.getElementById('issuesContainer').style.display = 'block';
        document.getElementById('issuesList').innerHTML = `
            <div class="no-issues">
                <i class="material-icons mi">warning</i>
                <h3>API Rate Limit Exceeded</h3>
                <p>GitHub API rate limit reached. Please try again later or Add a GitHub token to increase your rate limit.</p>
                <p>You can still use the filters - they will work once the API is accessible again.</p>
            </div>
        `;

        // Hide pagination
        document.getElementById('paginationContainer').innerHTML = '';
    }
}

// Git Issues Account Management Functions
function commitGitIssuesAccount(options = {}) {
    const { allowEmpty = false } = options;
    const gitIssuesAccountField = document.getElementById("gitIssuesAccount");
    if (!gitIssuesAccountField) return;

    const gitIssuesAccount = gitIssuesAccountField.value.trim();
    if (!gitIssuesAccount && !allowEmpty) {
        return;
    }

    if (gitIssuesAccount) {
        localStorage.gitAccount = gitIssuesAccount;
    } else {
        localStorage.removeItem('gitAccount');
    }

    // Update the display
    updateGitAccountDisplay();

    // Update assignee button default if needed
    updateAssigneeButtonDefault();
}

function updateGitAccountDisplay() {
    const gitIssuesAccountElement = document.getElementById("gitIssuesAccount");
    const gitAccount = localStorage.gitAccount || (gitIssuesAccountElement ? gitIssuesAccountElement.value : '');
    const gitAccountDisplay = document.getElementById("gitAccountDisplay");
    const gitAccountLink = document.getElementById("gitAccountLink");

    if (gitAccount && gitAccount.trim() !== '' && gitAccountDisplay && gitAccountLink) {
        // Show GitHub account when available
        gitAccountLink.textContent = gitAccount;
        gitAccountLink.href = `https://github.com/${gitAccount}`;
        gitAccountDisplay.innerHTML = ` Your GitHub account: <a href="https://github.com/${gitAccount}" id="gitAccountLink">${gitAccount}</a>&nbsp;&nbsp;`;
        gitAccountDisplay.style.display = 'inline-block';
    } else if (gitAccountDisplay) {
        gitAccountDisplay.style.display = 'none';
    }
}

function updateAssigneeButtonDefault() {
    const gitAccount = localStorage.gitAccount;
    if (!gitAccount || !issuesManager) return;

    // Check if gitAccount exists in the assignees list
    if (issuesManager.assignees && issuesManager.assignees.has(gitAccount)) {
        // Only set as default if no other assignee value is cached
        const cachedAssignee = localStorage.getItem('issuesManager_assignee');
        if (!cachedAssignee || cachedAssignee === 'all') {
            issuesManager.filters.assignee = gitAccount;
            issuesManager.updateAssigneeButton();
        }
    }
}

// Initialize Git Issues Account on page load
function initGitIssuesAccountField() {
    const gitIssuesAccountField = document.getElementById("gitIssuesAccount");
    if (!gitIssuesAccountField) return;

    // Load from localStorage if available
    if (localStorage.gitAccount) {
        gitIssuesAccountField.value = localStorage.gitAccount;
    }

    gitIssuesAccountField.addEventListener('blur', () => {
        if (gitIssuesAccountField.value.trim() !== '') {
            commitGitIssuesAccount({ allowEmpty: false });
        }
    });

    // Update the display initially
    updateGitAccountDisplay();
}

if (typeof waitForElm === 'function') {
    waitForElm('#gitIssuesAccount').then(() => initGitIssuesAccountField());
} else {
    document.addEventListener('DOMContentLoaded', initGitIssuesAccountField);
}

// Initialize the issues manager.
// Supports lazy script loading after DOMContentLoaded.
var issuesManager;
function initIssuesManager(containerElement = null) {
    if (issuesManager) {
        return issuesManager;
    }

    const container = containerElement || document.getElementById('issuesWidget');
    if (!container) {
        return null;
    }

    const containerId = container.dataset.containerId || 'issuesWidget';
    issuesManager = new GitHubIssuesManager(containerId);
    return issuesManager;
}

// Expose for pages that lazy-load this script.
window.initIssuesManager = initIssuesManager;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initIssuesManager());
} else {
    initIssuesManager();
}
