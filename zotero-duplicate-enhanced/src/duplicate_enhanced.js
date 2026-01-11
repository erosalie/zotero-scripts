/**
 * Zotero Duplicate Detection Script v2.2
 * 
 * Improvements over original:
 * - Fixed critical bug: original items are now preserved for tagging/trashing
 * - Fixed Jaccard similarity NaN when both strings are empty
 * - Added Levenshtein distance for better title matching
 * - Added URL field comparison
 * - Added exact match detection for URL/DOI (instant duplicate detection)
 * - Added progress reporting for large libraries
 * - Added batch action option (apply same action to all)
 * - Added concurrency prevention
 * - Added recursive collection processing option
 * - Better error handling and logging
 * - More informative duplicate display
 * 
 * v2.1: Added cross-type duplicate detection (e.g., journalArticle vs webpage)
 * 
 * v2.2: Reordered weights by priority:
 *       1. URL (25%) - highest, unique identifier
 *       2. DOI (22%) - reliable identifier  
 *       3. Title (20%) - main content identifier
 *       4. Author (15%) - creator matching
 *       5. Year (10%) - date matching
 *       6. Publisher/Publication (8%) - publisher and journal
 */

(async function() {
    // Prevent concurrent runs
    if (typeof window !== 'undefined' && window._duplicateDetectionRunning) {
        alert("Duplicate detection is already running. Please wait for it to complete.");
        return;
    }
    if (typeof window !== 'undefined') {
        window._duplicateDetectionRunning = true;
    }

    const startTime = performance.now();
    const VERSION = "2.2";

    try {
        console.log(`=== Zotero Duplicate Detection v${VERSION} ===`);
        
        const items = await getItemsToEdit();
        if (!items || items.length === 0) {
            console.log("No items to process.");
            return;
        }

        // Filter out attachments and notes - only process regular items
        const regularItems = items.filter(item => item.isRegularItem());
        if (regularItems.length === 0) {
            alert("No regular items to process (only attachments/notes found).");
            return;
        }

        console.log(`Processing ${regularItems.length} regular items (filtered from ${items.length} total)`);

        // Weights in priority order: URL, DOI, Title, Author, Year, Publisher/Publication
        const weights = {
            URL: 0.25,          // Highest - unique identifier
            DOI: 0.22,          // Second - reliable identifier
            title: 0.20,        // Third - main content identifier
            creators: 0.15,     // Fourth - author matching
            date: 0.10,         // Fifth - year matching
            publisher: 0.04,    // Sixth - publisher/publication
            journal: 0.04,      // Sixth - publication title
            shortTitle: 0.00,   // Not prioritized
            place: 0.00,        // Not prioritized
            ISBN: 0.00,         // Not prioritized
            itemType: 0.00      // Not prioritized
        };

        normalizeWeights(weights);

        // Get user preferences
        const userPrefs = getUserPreferences(weights);
        if (userPrefs === null) return;

        const { threshold, useExactMatch, useFuzzyTitle, requireSameType } = userPrefs;

        const weightsConfirmedTime = performance.now();
        logTime("Configuration time", weightsConfirmedTime - startTime);

        console.log(`Settings: threshold=${threshold}, exactMatch=${useExactMatch}, fuzzyTitle=${useFuzzyTitle}, requireSameType=${requireSameType}`);
        console.log(`Items to compare: ${regularItems.length}`);

        // Detect duplicates
        const potentialDuplicates = await detectDuplicates(
            regularItems, 
            threshold, 
            weights, 
            useExactMatch, 
            useFuzzyTitle,
            requireSameType
        );
        
        const duplicatesDetectedTime = performance.now();
        logTime("Duplicate detection time", duplicatesDetectedTime - weightsConfirmedTime);

        console.log(`Found ${potentialDuplicates.length} potential duplicate pairs`);

        // Handle duplicates
        await handleDetectedDuplicates(potentialDuplicates);

        alert(`Duplicate detection completed.\nFound ${potentialDuplicates.length} potential duplicate pairs.`);

    } catch (error) {
        console.error(`Error in duplicate detection: ${error.message}`);
        console.error(error.stack);
        alert(`An error occurred: ${error.message}`);
    } finally {
        if (typeof window !== 'undefined') {
            window._duplicateDetectionRunning = false;
        }
        const endTime = performance.now();
        logTime("Total execution time", endTime - startTime);
        console.log("=== Duplicate detection complete ===");
    }
})();


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function logTime(label, timeMs) {
    console.log(`${label}: ${(timeMs / 1000).toFixed(2)} seconds`);
}

function normalizeWeights(weights) {
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight === 0) return;
    for (let key in weights) {
        weights[key] /= totalWeight;
    }
}


// ============================================================================
// USER INPUT FUNCTIONS
// ============================================================================

function getUserPreferences(weights) {
    const weightsInfo = Object.entries(weights)
        .map(([key, value]) => `  ${key}: ${(value * 100).toFixed(1)}%`)
        .join('\n');

    const message = `Zotero Duplicate Detection v2.2\n\n` +
        `Current weights:\n${weightsInfo}\n\n` +
        `Options (enter comma-separated, e.g., "0.6,yes,yes,no"):\n` +
        `1. Similarity threshold (0-1, default: 0.6)\n` +
        `2. Use exact URL/DOI match? (yes/no, default: yes)\n` +
        `3. Use fuzzy title matching? (yes/no, default: yes)\n` +
        `4. Require same item type? (yes/no, default: no)\n\n` +
        `Or just enter a number for threshold with defaults:`;

    const input = prompt(message, "0.6,yes,yes,no");
    
    if (input === null) return null;
    
    const parts = input.trim().split(',').map(s => s.trim().toLowerCase());
    
    // Parse threshold
    const threshold = parseFloat(parts[0]) || 0.6;
    if (threshold < 0 || threshold > 1) {
        alert("Invalid threshold. Using default 0.6");
    }
    
    // Parse exact match preference
    const useExactMatch = parts[1] !== 'no';
    
    // Parse fuzzy title preference  
    const useFuzzyTitle = parts[2] !== 'no';
    
    // Parse item type requirement (default: NO - allow cross-type duplicates)
    const requireSameType = parts[3] === 'yes';
    
    return {
        threshold: Math.max(0, Math.min(1, threshold)),
        useExactMatch,
        useFuzzyTitle,
        requireSameType
    };
}


// ============================================================================
// ITEM RETRIEVAL
// ============================================================================

async function getItemsToEdit() {
    try {
        const zoteroPane = Zotero.getActiveZoteroPane();
        
        const editOption = prompt(
            "Select items to process:\n\n" +
            "1. Selected items only\n" +
            "2. Current collection\n" +
            "3. Current collection + subcollections\n" +
            "4. Saved search results\n" +
            "5. Entire library\n\n" +
            "Enter choice (1-5):",
            "1"
        );

        if (editOption === null) return null;
        
        const choice = editOption.trim();
        let items = [];
        let description = "";

        switch (choice) {
            case '1':
                items = zoteroPane.getSelectedItems();
                if (!items.length) {
                    alert("No items selected.");
                    return null;
                }
                description = `Selected Items (${items.length})`;
                break;

            case '2':
                const collection = zoteroPane.getSelectedCollection();
                if (!collection) {
                    alert("No collection selected.");
                    return null;
                }
                items = await collection.getChildItems();
                description = `Collection: ${collection.name} (${items.length})`;
                break;

            case '3':
                const parentCollection = zoteroPane.getSelectedCollection();
                if (!parentCollection) {
                    alert("No collection selected.");
                    return null;
                }
                items = await getCollectionItemsRecursive(parentCollection);
                description = `Collection (recursive): ${parentCollection.name} (${items.length})`;
                break;

            case '4':
                const savedSearch = zoteroPane.getSelectedSavedSearch();
                if (!savedSearch) {
                    alert("No saved search selected.");
                    return null;
                }
                const search = new Zotero.Search();
                search.libraryID = savedSearch.libraryID;
                search.addCondition('savedSearchID', 'is', savedSearch.id);
                const itemIDs = await search.search();
                if (itemIDs.length === 0) {
                    alert("No items found in the saved search.");
                    return null;
                }
                items = await Zotero.Items.getAsync(itemIDs);
                description = `Saved Search (${items.length})`;
                break;

            case '5':
                const libraryID = zoteroPane.getSelectedLibraryID();
                items = await Zotero.Items.getAll(libraryID);
                description = `Entire Library (${items.length})`;
                break;

            default:
                items = zoteroPane.getSelectedItems();
                if (!items.length) {
                    alert("No items selected.");
                    return null;
                }
                description = `Selected Items (${items.length})`;
        }

        console.log(`Source: ${description}`);
        return items;

    } catch (error) {
        console.error(`Error getting items: ${error.message}`);
        alert(`Error retrieving items: ${error.message}`);
        return null;
    }
}

async function getCollectionItemsRecursive(collection) {
    let items = await collection.getChildItems();
    
    const childCollections = collection.getChildCollections();
    for (const childCollection of childCollections) {
        const childItems = await getCollectionItemsRecursive(childCollection);
        items = items.concat(childItems);
    }
    
    // Remove duplicates by ID
    const seen = new Set();
    return items.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}


// ============================================================================
// FIELD NORMALIZATION
// ============================================================================

function normalizeItemFields(item) {
    const normalized = {
        id: item.id,
        originalItem: item,  // CRITICAL: Keep reference to original item
        title: normalizeField(item.getField('title')),
        shortTitle: normalizeField(item.getField('shortTitle')),
        date: normalizeField(item.getField('date')),
        publisher: normalizeField(item.getField('publisher')),
        place: normalizeField(item.getField('place')),
        journal: normalizeField(item.getField('publicationTitle') || item.getField('journalAbbreviation')),
        DOI: normalizeDOI(item.getField('DOI')),
        ISBN: normalizeISBN(item.getField('ISBN')),
        URL: normalizeURL(item.getField('url')),
        itemType: (item.itemType || '').toLowerCase().trim(),
        creators: normalizeCreators(item.getCreators()),
        year: extractYear(item.getField('date'))
    };
    
    return normalized;
}

function normalizeField(field) {
    if (!field) return '';
    return field
        .toString()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"']/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

function normalizeDOI(doi) {
    if (!doi) return '';
    // Extract DOI pattern (10.xxxx/xxxxx)
    const match = doi.match(/10\.\d{4,}\/[^\s]+/i);
    return match ? match[0].toLowerCase() : '';
}

function normalizeISBN(isbn) {
    if (!isbn) return '';
    // Remove all non-digit characters except X (for ISBN-10 checksum)
    return isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeURL(url) {
    if (!url) return '';
    // Remove protocol and trailing slashes
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

function normalizeCreators(creators) {
    if (!creators || !creators.length) return '';
    return creators
        .map(c => {
            const name = `${c.firstName || ''} ${c.lastName || c.name || ''}`;
            return name.toLowerCase().trim();
        })
        .filter(n => n.length > 0)
        .sort()
        .join(' ');
}

function extractYear(dateStr) {
    if (!dateStr) return '';
    const match = dateStr.match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : '';
}


// ============================================================================
// SIMILARITY ALGORITHMS
// ============================================================================

function jaccardSimilarity(str1, str2) {
    if (!str1 && !str2) return 1.0;  // Both empty = identical
    if (!str1 || !str2) return 0.0;  // One empty = no similarity
    
    const set1 = new Set(str1.split(/\s+/).filter(s => s.length > 0));
    const set2 = new Set(str2.split(/\s+/).filter(s => s.length > 0));
    
    if (set1.size === 0 && set2.size === 0) return 1.0;
    if (set1.size === 0 || set2.size === 0) return 0.0;
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

function levenshteinDistance(str1, str2) {
    if (!str1) return str2 ? str2.length : 0;
    if (!str2) return str1.length;
    
    const m = str1.length;
    const n = str2.length;
    
    // Use single array optimization for memory efficiency
    let prev = Array(n + 1).fill(0).map((_, i) => i);
    let curr = Array(n + 1).fill(0);
    
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,      // deletion
                curr[j - 1] + 1,  // insertion
                prev[j - 1] + cost // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }
    
    return prev[n];
}

function levenshteinSimilarity(str1, str2) {
    if (!str1 && !str2) return 1.0;
    if (!str1 || !str2) return 0.0;
    
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;
    
    const distance = levenshteinDistance(str1, str2);
    return 1 - (distance / maxLen);
}

function combinedTitleSimilarity(title1, title2, useFuzzy = true) {
    const jaccard = jaccardSimilarity(title1, title2);
    
    if (!useFuzzy) return jaccard;
    
    // For short titles, Levenshtein is more reliable
    // For long titles, Jaccard handles word reordering better
    const levenshtein = levenshteinSimilarity(title1, title2);
    
    // Weight based on title length
    const avgLen = (title1.length + title2.length) / 2;
    const levenshteinWeight = Math.max(0, 1 - (avgLen / 100));
    
    return (jaccard * (1 - levenshteinWeight)) + (levenshtein * levenshteinWeight);
}


// ============================================================================
// DUPLICATE DETECTION
// ============================================================================

function calculateSimilarity(item1, item2, weights, useFuzzyTitle = true, requireSameType = false) {
    // If requiring same type and types don't match, return 0
    if (requireSameType && item1.itemType !== item2.itemType) {
        return 0;
    }

    let totalWeight = 0;
    let combinedSimilarity = 0;

    // 1. URL (highest priority) - exact match
    if (weights.URL > 0) {
        const urlSim = item1.URL && item2.URL && item1.URL === item2.URL ? 1.0 : 
                       jaccardSimilarity(item1.URL, item2.URL);
        combinedSimilarity += urlSim * weights.URL;
        totalWeight += weights.URL;
    }

    // 2. DOI (second priority) - exact match
    if (weights.DOI > 0) {
        const doiSim = item1.DOI && item2.DOI && item1.DOI === item2.DOI ? 1.0 : 0.0;
        combinedSimilarity += doiSim * weights.DOI;
        totalWeight += weights.DOI;
    }

    // 3. Title (third priority) - with optional fuzzy matching
    if (weights.title > 0) {
        const titleSim = combinedTitleSimilarity(item1.title, item2.title, useFuzzyTitle);
        combinedSimilarity += titleSim * weights.title;
        totalWeight += weights.title;
    }

    // 4. Creators/Authors (fourth priority)
    if (weights.creators > 0) {
        const creatorSim = jaccardSimilarity(item1.creators, item2.creators);
        combinedSimilarity += creatorSim * weights.creators;
        totalWeight += weights.creators;
    }

    // 5. Date/Year (fifth priority) - exact year match is more meaningful
    if (weights.date > 0) {
        const dateSim = item1.year && item2.year && item1.year === item2.year ? 1.0 : 
                        jaccardSimilarity(item1.date, item2.date);
        combinedSimilarity += dateSim * weights.date;
        totalWeight += weights.date;
    }

    // 6. Publisher (sixth priority)
    if (weights.publisher > 0) {
        const pubSim = jaccardSimilarity(item1.publisher, item2.publisher);
        combinedSimilarity += pubSim * weights.publisher;
        totalWeight += weights.publisher;
    }

    // 6. Journal/Publication (sixth priority, tied with publisher)
    if (weights.journal > 0) {
        const journalSim = jaccardSimilarity(item1.journal, item2.journal);
        combinedSimilarity += journalSim * weights.journal;
        totalWeight += weights.journal;
    }

    // Lower priority fields (only if weight > 0)
    const lowPriorityFields = ['shortTitle', 'place', 'ISBN'];
    for (const field of lowPriorityFields) {
        if (weights[field] > 0) {
            const sim = jaccardSimilarity(item1[field], item2[field]);
            combinedSimilarity += sim * weights[field];
            totalWeight += weights[field];
        }
    }

    // Item type handling
    if (weights.itemType > 0) {
        if (requireSameType) {
            combinedSimilarity += 1.0 * weights.itemType;
            totalWeight += weights.itemType;
        }
        // If not requiring same type, skip itemType weight entirely
    }

    return totalWeight > 0 ? combinedSimilarity / totalWeight : 0;
}

function checkExactIdentifierMatch(item1, item2) {
    // URL match (highest priority)
    if (item1.URL && item2.URL && item1.URL === item2.URL) {
        return { match: true, type: 'URL', value: item1.URL };
    }
    
    // DOI match (second priority)
    if (item1.DOI && item2.DOI && item1.DOI === item2.DOI) {
        return { match: true, type: 'DOI', value: item1.DOI };
    }
    
    return { match: false };
}

async function detectDuplicates(items, threshold, weights, useExactMatch, useFuzzyTitle, requireSameType) {
    const potentialDuplicates = [];
    const normalizedItems = [];
    
    // Progress reporting
    const totalComparisons = (items.length * (items.length - 1)) / 2;
    let comparisonsDone = 0;
    let lastProgress = 0;

    console.log(`Normalizing ${items.length} items...`);
    
    // Normalize all items first
    for (const item of items) {
        normalizedItems.push(normalizeItemFields(item));
    }

    console.log(`Starting ${totalComparisons} comparisons...`);
    console.log(`Cross-type duplicates: ${requireSameType ? 'DISABLED' : 'ENABLED'}`);

    // Compare all pairs
    for (let i = 0; i < normalizedItems.length; i++) {
        const item1 = normalizedItems[i];
        
        for (let j = i + 1; j < normalizedItems.length; j++) {
            const item2 = normalizedItems[j];
            comparisonsDone++;
            
            // Progress reporting every 10%
            const progress = Math.floor((comparisonsDone / totalComparisons) * 10);
            if (progress > lastProgress) {
                console.log(`Progress: ${progress * 10}% (${comparisonsDone}/${totalComparisons})`);
                lastProgress = progress;
            }

            let isDuplicate = false;
            let similarity = 0;
            let matchReason = '';

            // Check exact identifier match first (fast path)
            // Note: DOI/ISBN matches should work across item types
            if (useExactMatch) {
                const exactMatch = checkExactIdentifierMatch(item1, item2);
                if (exactMatch.match) {
                    isDuplicate = true;
                    similarity = 1.0;
                    matchReason = `Exact ${exactMatch.type} match: ${exactMatch.value}`;
                    
                    // Add item type info if different
                    if (item1.itemType !== item2.itemType) {
                        matchReason += ` (types differ: ${item1.itemType} vs ${item2.itemType})`;
                    }
                }
            }

            // If no exact match, calculate similarity
            if (!isDuplicate) {
                similarity = calculateSimilarity(item1, item2, weights, useFuzzyTitle, requireSameType);
                if (similarity >= threshold) {
                    isDuplicate = true;
                    matchReason = `Similarity: ${(similarity * 100).toFixed(1)}%`;
                    
                    // Add item type info if different
                    if (item1.itemType !== item2.itemType) {
                        matchReason += ` (types differ: ${item1.itemType} vs ${item2.itemType})`;
                    }
                }
            }

            if (isDuplicate) {
                potentialDuplicates.push({
                    item1: item1,
                    item2: item2,
                    similarity: similarity,
                    reason: matchReason
                });
            }
        }
    }

    // Sort by similarity (highest first)
    potentialDuplicates.sort((a, b) => b.similarity - a.similarity);

    return potentialDuplicates;
}


// ============================================================================
// DUPLICATE HANDLING
// ============================================================================

async function handleDetectedDuplicates(duplicates) {
    if (duplicates.length === 0) {
        console.log("No duplicates found.");
        alert("No duplicates found.");
        return;
    }

    // Ask user for batch handling preference
    const batchChoice = prompt(
        `Found ${duplicates.length} potential duplicate pairs.\n\n` +
        `How would you like to handle them?\n\n` +
        `1. Review each pair individually\n` +
        `2. Tag all pairs (add 'duplicate-check' tag)\n` +
        `3. Show summary only (no changes)\n\n` +
        `Enter choice (1-3):`,
        "1"
    );

    if (batchChoice === null) return;

    const choice = batchChoice.trim();

    if (choice === '2') {
        // Batch tag all
        await batchTagDuplicates(duplicates);
        return;
    }

    if (choice === '3') {
        // Summary only
        showDuplicateSummary(duplicates);
        return;
    }

    // Individual review (default)
    await reviewDuplicatesIndividually(duplicates);
}

async function batchTagDuplicates(duplicates) {
    const timestamp = Date.now();
    const tag = `duplicate-check-${timestamp}`;
    
    const taggedItems = new Set();
    let pairCount = 0;

    for (const { item1, item2 } of duplicates) {
        const original1 = item1.originalItem;
        const original2 = item2.originalItem;

        if (!taggedItems.has(original1.id)) {
            original1.addTag(tag);
            await original1.saveTx();
            taggedItems.add(original1.id);
        }

        if (!taggedItems.has(original2.id)) {
            original2.addTag(tag);
            await original2.saveTx();
            taggedItems.add(original2.id);
        }

        pairCount++;
    }

    console.log(`Tagged ${taggedItems.size} items in ${pairCount} duplicate pairs with tag: ${tag}`);
    alert(`Tagged ${taggedItems.size} items with tag: ${tag}\n\nYou can find all potential duplicates by searching for this tag.`);
}

function showDuplicateSummary(duplicates) {
    console.log("\n=== DUPLICATE SUMMARY ===\n");
    
    for (let i = 0; i < Math.min(duplicates.length, 50); i++) {
        const { item1, item2, similarity, reason } = duplicates[i];
        console.log(`Pair ${i + 1}: ${reason}`);
        console.log(`  Item 1: ${item1.title}`);
        console.log(`  Item 2: ${item2.title}`);
        console.log('');
    }

    if (duplicates.length > 50) {
        console.log(`... and ${duplicates.length - 50} more pairs`);
    }

    alert(`Found ${duplicates.length} duplicate pairs.\nCheck the console for the full list.`);
}

async function reviewDuplicatesIndividually(duplicates) {
    const timestamp = Date.now();
    let processed = 0;
    let tagged = 0;
    let trashed = 0;
    let skipped = 0;

    for (const { item1, item2, similarity, reason } of duplicates) {
        processed++;
        
        const original1 = item1.originalItem;
        const original2 = item2.originalItem;

        // Build informative prompt
        const info1 = buildItemInfo(item1);
        const info2 = buildItemInfo(item2);

        const action = prompt(
            `Duplicate ${processed}/${duplicates.length}\n` +
            `${reason}\n\n` +
            `--- ITEM 1 ---\n${info1}\n\n` +
            `--- ITEM 2 ---\n${info2}\n\n` +
            `Actions:\n` +
            `1. Tag both items\n` +
            `2. Trash Item 2 (keep Item 1)\n` +
            `3. Trash Item 1 (keep Item 2)\n` +
            `4. Skip this pair\n` +
            `5. Stop reviewing\n\n` +
            `Enter choice (1-5):`,
            "4"
        );

        if (action === null || action.trim() === '5') {
            console.log("User stopped reviewing.");
            break;
        }

        const choice = action.trim();

        try {
            switch (choice) {
                case '1':
                    const tag = `duplicate-pair-${timestamp}`;
                    original1.addTag(tag);
                    original2.addTag(tag);
                    await original1.saveTx();
                    await original2.saveTx();
                    tagged += 2;
                    console.log(`Tagged pair: "${item1.title}" and "${item2.title}"`);
                    break;

                case '2':
                    await Zotero.Items.trashTx(original2.id);
                    trashed++;
                    console.log(`Trashed Item 2: "${item2.title}"`);
                    break;

                case '3':
                    await Zotero.Items.trashTx(original1.id);
                    trashed++;
                    console.log(`Trashed Item 1: "${item1.title}"`);
                    break;

                default:
                    skipped++;
                    console.log(`Skipped pair: "${item1.title}" and "${item2.title}"`);
            }
        } catch (error) {
            console.error(`Error processing duplicate: ${error.message}`);
        }
    }

    const summary = `Review complete!\n\n` +
        `Pairs reviewed: ${processed}\n` +
        `Items tagged: ${tagged}\n` +
        `Items trashed: ${trashed}\n` +
        `Pairs skipped: ${skipped}`;
    
    console.log(summary);
    alert(summary);
}

function buildItemInfo(normalizedItem) {
    const parts = [];
    
    // Show fields in priority order
    if (normalizedItem.itemType) {
        parts.push(`Type: ${normalizedItem.itemType}`);
    }
    if (normalizedItem.URL) {
        parts.push(`URL: ${normalizedItem.URL}`);
    }
    if (normalizedItem.DOI) {
        parts.push(`DOI: ${normalizedItem.DOI}`);
    }
    if (normalizedItem.title) {
        parts.push(`Title: ${normalizedItem.title}`);
    }
    if (normalizedItem.creators) {
        parts.push(`Authors: ${normalizedItem.creators}`);
    }
    if (normalizedItem.year) {
        parts.push(`Year: ${normalizedItem.year}`);
    }
    if (normalizedItem.publisher) {
        parts.push(`Publisher: ${normalizedItem.publisher}`);
    }
    if (normalizedItem.journal) {
        parts.push(`Publication: ${normalizedItem.journal}`);
    }

    return parts.join('\n');
}