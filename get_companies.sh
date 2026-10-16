#!/bin/zsh

LOCATION="${1:-}"
BUSINESS_LINE="${2:-}"

loc_part="${LOCATION:-finland}"
bus_part="${BUSINESS_LINE:-all}"
OUTPUT_FILE="${loc_part}${bus_part}.json"

BASE_URL="https://avoindata.prh.fi/opendata-ytj-api/v3/companies"

page=1
temp_dir=$(mktemp -d)
response_files=()

while true; do
    query="page=$page"
    [[ -n "$LOCATION" ]] && query+="&location=$LOCATION"
    [[ -n "$BUSINESS_LINE" ]] && query+="&mainBusinessLine=$BUSINESS_LINE"
    
    url="${BASE_URL}?${query}"
    echo "Fetching page $page..."
    
    response_file="$temp_dir/page_$page.json"
    curl -s -X 'GET' "$url" -H 'accept: application/json' > "$response_file"
    
    count=$(jq '.companies // [] | length' "$response_file")
    
    if [[ $count -eq 0 ]]; then
        rm "$response_file"
        break
    fi
    
    if [[ $page -gt 1 ]]; then
        if cmp -s "$response_file" "$temp_dir/page_1.json"; then
            echo "Reached end of pagination (wrapped back to page 1)."
            rm "$response_file"
            break
        fi
    fi
    
    response_files+=("$response_file")
    ((page++))
done

mkdir -p ./data

jq -s '[
    .[].companies[]? | {
        businessId: .businessId.value,
        name: (.names[0].name // null),
        businessLine: (([.mainBusinessLine.descriptions[]? | select(.languageCode == "1") | .description] | first) // .mainBusinessLine.descriptions[0].description // null),
        city: (.addresses[0].postOffices[]? | select(.languageCode=="1").city // null),
        street: ([.addresses[0].street, .addresses[0].buildingNumber, .addresses[0].entrance] | map(select(. != null and . != "")) | if length > 0 then join(" ") else null end),
        postCode: (.addresses[0].postCode // null)
    }
] | unique_by(.businessId)' "${response_files[@]}" > ./data/"$OUTPUT_FILE"

rm -rf "$temp_dir"
echo "Done! Saved to $OUTPUT_FILE"