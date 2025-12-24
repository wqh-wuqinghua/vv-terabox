#!/bin/bash

### Simple TeraBox Upload Script
### Based on MUNFAQQIHA's proven script - single method, no fallbacks
### Original: https://github.com/MUNFAQQIHA (proven working on Linux/Windows)

set +H

# Configuration from environment variables
jt="${TERABOX_JSTOKEN}"
bt="${TERABOX_BDSTOKEN}"
co="${TERABOX_COOKIE}"
rf="${TERABOX_REMOTE_FOLDER:-/rtsp-videos}"
dd_webhook="${DINGDING_WEBHOOK}"

# Fixed configuration
ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
bo='https://www.terabox.com'

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function to send DingTalk notification
send_dingtalk_notification() {
    local title="$1"
    local message="$2"

    if [[ -z "$dd_webhook" ]]; then
        log "⚠️  DingTalk webhook not configured, skipping notification"
        return 0
    fi

    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local json_payload=$(jq -n \
        --arg title "$title" \
        --arg text "$message" \
        --arg timestamp "$timestamp" \
        '{
            "msgtype": "markdown",
            "markdown": {
                "title": $title,
                "text": ("### " + $title + "\n\n" + $text + "\n\n---\n\n**时间:** " + $timestamp + "\n\n**消息推送**")
            }
        }')

    local response=$(curl -s -w "\n%{http_code}" -X POST "$dd_webhook" \
        -H "Content-Type: application/json" \
        -d "$json_payload")

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | head -n-1)

    if [[ "$http_code" == "200" ]]; then
        log "✅ DingTalk notification sent successfully"
        return 0
    else
        log "⚠️  Failed to send DingTalk notification (HTTP $http_code): $body"
        return 1
    fi
}

# Function to check if required variables are set
check_config() {
    if [[ -z "$jt" || -z "$co" ]]; then
        log "ERROR: Missing required TeraBox configuration"
        log "Required environment variables:"
        log "  TERABOX_JSTOKEN"
        log "  TERABOX_COOKIE"
        log "Optional:"
        log "  TERABOX_BDSTOKEN (recommended)"
        log "  TERABOX_REMOTE_FOLDER (default: /rtsp-videos)"
        return 1
    fi
    
    if [[ -z "$bt" ]]; then
        log "WARNING: TERABOX_BDSTOKEN not provided - some operations may fail"
    fi
    
    return 0
}

# MUNFAQQIHA's proven upload method
upload_file() {
    local yu="$1"
    
    if [[ ! -f "$yu" ]]; then
        log "ERROR: File not found: $yu"
        return 1
    fi
    
    log "🚀 Starting upload: $(basename "$yu")"
    
    # Get fresh tokens from the website (MUNFAQQIHA's method)
    log "Refreshing authentication tokens..."
    local nfo=$(curl -sL "${bo}" -A "${ua}" -b "${co}" -e "${bo}/" | perl -pe 's/\%(\w\w)/chr hex $1/ge' | sed "s#\"#\\n#g;s|:||g;s|,||g" | awk 'NF')
    
    if [[ -n "$nfo" ]]; then
        local fresh_jt=$(echo "$nfo" | grep -i 'jstok.*' -A1 | tail -1)
        local fresh_bt=$(echo "$nfo" | grep -i 'bdsto.*' -A1 | tail -1)
        
        # Use fresh tokens if available
        if [[ -n "$fresh_jt" ]]; then
            jt="$fresh_jt"
            log "✅ Refreshed jsToken"
        fi
        if [[ -n "$fresh_bt" ]]; then
            bt="$fresh_bt"
            log "✅ Refreshed bdstoken"
        fi
    fi
    
    # Get file size and check quota
    local sz=$(du -b "${yu}" 2>/dev/null | awk '{print $1}')
    if [[ -z "${sz/[ ]*\n/}" || "$sz" -eq 0 ]]; then
        log "ERROR: Invalid file size for $yu"
        return 1
    fi
    
    log "📁 File size: $(numfmt --to=iec-i --suffix=B $sz)"
    
    # Check quota
    log "🔍 Checking storage quota..."
    local qt=$(curl -s "${bo}/api/quota?checkexpire=1&checkfree=1&app_id=250528&jsToken=${jt}" -A "${ua}" -b "${co}" -e "${bo}/")
    local to=$(echo "$qt" | jq -r '.total // 0' 2>/dev/null)
    local us=$(echo "$qt" | jq -r '.used // 0' 2>/dev/null)
    
    if [[ -n "$to" && -n "$us" && "$to" -gt 0 ]]; then
        local available=$((to - us))
        if [[ $available -lt $sz ]]; then
            log "❌ ERROR: Insufficient quota. Available: $(numfmt --to=iec-i --suffix=B $available), Required: $(numfmt --to=iec-i --suffix=B $sz)"
            return 1
        fi
        log "✅ Quota OK. Available: $(numfmt --to=iec-i --suffix=B $available)"
    fi
    
    # Check VIP status for file size limits
    local vi=$(curl -s "${bo}/rest/2.0/membership/proxy/user?method=query" -A "${ua}" -b "${co}" -e "${bo}/" | jq -r '.data.member_info.is_vip // 0' 2>/dev/null)
    local max_size=4294967296  # 4GB for free users
    if [[ "$vi" == "1" ]]; then
        max_size=21474836479  # 20GB for VIP users
        log "👑 VIP account detected (max file: 20GB)"
    else
        log "👤 Free account (max file: 4GB)"
    fi
    
    if [[ $sz -gt $max_size ]]; then
        log "❌ ERROR: File size exceeds limit. Max: $(numfmt --to=iec-i --suffix=B $max_size), Current: $(numfmt --to=iec-i --suffix=B $sz)"
        return 1
    fi
    
    # Handle large files (split if > 2GB)
    local piece_file="piece${yu//\//_}0a"
    local md5_file="piece${yu//\//_}0b"
    local prefix="piece${yu//\//_}"
    
    # Clean up any existing pieces
    rm -f "${prefix}"* 2>/dev/null
    
    if [[ $sz -ge 2147483648 ]]; then
        log "📦 Large file detected, splitting into 120MB pieces..."
        if ! split --verbose -b 120M "${yu}" --suffix-length=3 --numeric-suffixes=0 "${prefix}"; then
            log "❌ ERROR: Failed to split file"
            return 1
        fi
        ls -1 "${prefix}"[0-9]* > "$piece_file"
    else
        echo "${yu}" > "$piece_file"
    fi
    
    # Generate MD5 for each piece
    log "🔐 Generating MD5 checksums..."
    rm -f "$md5_file"
    while read md; do
        if [[ -f "$md" ]]; then
            md5sum "$md" | cut -d ' ' -f1 >> "$md5_file"
        fi
    done < "$piece_file"
    
    local md5=$(cat "$md5_file" | sed -n 's/^/"/;s/$/"/;H;${x;s/\n/,/g;s/^,//;p}' | awk '{print "["$0"]"}')
    local fp=$(echo "${rf}/$(basename "${yu}")" | jq -Rr @uri)
    local tp=$(echo "${rf}/" | sed 's#/*$##;${s|$|/|}')
    
    # Precreate file
    log "🎯 Preparing upload on TeraBox..."
    local pc=$(curl -s "${bo}/api/precreate?app_id=250528&jsToken=${jt}" -A "${ua}" -b "${co}" -H "Origin: ${bo}" -e "${bo}/" \
        --data-raw "path=${fp}&size=${sz}&autoinit=1&rtype=3&target_path=${tp}&block_list=${md5}")

    if ! echo "$pc" | jq -e '.uploadid' >/dev/null 2>&1; then
        local errno=$(echo "$pc" | jq -r '.errno // -1')
        local errmsg=$(echo "$pc" | jq -r '.errmsg // "unknown error"')
        log "❌ ERROR: Precreate failed. Response: $pc"

        # Send DingTalk notification for precreate failure
        local filename=$(basename "${yu}")
        local filesize=$(numfmt --to=iec-i --suffix=B $sz 2>/dev/null || echo "$sz bytes")
        send_dingtalk_notification \
            "⚠️ TeraBox 上传准备失败" \
            "**文件名:** \`$filename\`\n\n**文件大小:** $filesize\n\n**错误代码:** $errno\n\n**错误信息:** $errmsg\n\n**目标路径:** ${rf}/\n\n**可能原因:** 认证凭据已过期或需要验证，请更新 TERABOX_JSTOKEN, TERABOX_COOKIE, TERABOX_BDSTOKEN"

        rm -f "${prefix}"* 2>/dev/null
        return 1
    fi
    
    local ui=$(echo "$pc" | jq -r '.uploadid')
    log "🆔 Upload ID: $ui"
    
    # Upload pieces
    local bl=$(cat "$piece_file" | wc -l)
    local pr=1
    local ps=0
    
    if [[ $bl -gt 1 ]]; then
        log "⬆️  Uploading $bl file pieces..."
    else
        log "⬆️  Uploading file..."
    fi
    
    rm -f "piece${yu//\//_}0c"
    while read mi; do
        if [[ $bl -gt 1 ]]; then
            log "   📤 Piece $pr/$bl: $(basename "$mi")"
        fi
        
        local up=$(curl -s -F "file=@${mi}" "$(echo $bo | sed 's/www/c-jp/')/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&app_id=250528&path=${fp}&uploadid=${ui}&partseq=${ps}" \
            -A "${ua}" -b "${co}" -H "Origin: ${bo}" -e "${bo}/")
        
        local piece_md5=$(echo "${up}" | jq -r '.md5 // empty')
        if [[ -z "$piece_md5" || "$piece_md5" == "null" ]]; then
            log "❌ ERROR: Upload failed for piece $pr. Response: $up"
            rm -f "${prefix}"* 2>/dev/null
            return 1
        fi
        
        echo "$piece_md5" >> "piece${yu//\//_}0c"
        
        pr=$((pr + 1))
        ps=$((ps + 1))
    done < "$piece_file"
    
    # Final MD5 list
    local final_md5=$(cat "piece${yu//\//_}0c" | sed -n 's/^/"/;s/$/"/;H;${x;s/\n/,/g;s/^,//;p}' | awk '{print "["$0"]"}')
    
    # Create file
    log "🔗 Finalizing upload..."
    local create=$(curl -s "${bo}/api/create?isdir=0&rtype=1&bdstoken=${bt}&app_id=250528&jsToken=${jt}" -A "${ua}" -b "${co}" -H "Origin: ${bo}" -e "${bo}/" \
        --data-raw "path=${fp}&size=${sz}&uploadid=${ui}&target_path=${tp}&block_list=${final_md5}")
    
    # Check result
    if echo "$create" | jq -e '.errno == 0' >/dev/null 2>&1; then
        log "🎉 SUCCESS: File uploaded to ${rf}/$(basename "${yu}")"

        # Clean up pieces
        rm -f "${prefix}"* 2>/dev/null

        return 0
    else
        local errno=$(echo "$create" | jq -r '.errno // -1')
        local errmsg=$(echo "$create" | jq -r '.errmsg // "unknown error"')
        log "❌ ERROR: Upload failed (errno: $errno, message: $errmsg)"
        log "Response: $create"

        # Send DingTalk notification for upload failure
        local filename=$(basename "${yu}")
        local filesize=$(numfmt --to=iec-i --suffix=B $sz 2>/dev/null || echo "$sz bytes")
        send_dingtalk_notification \
            "⚠️ TeraBox 上传失败" \
            "**文件名:** \`$filename\`\n\n**文件大小:** $filesize\n\n**错误代码:** $errno\n\n**错误信息:** $errmsg\n\n**目标路径:** ${rf}/\n\n请检查 TeraBox 认证凭据是否过期"

        # Clean up pieces
        rm -f "${prefix}"* 2>/dev/null

        return 1
    fi
}

# Main function
main() {
    if [[ $# -eq 0 ]]; then
        log "Usage: $0 <file1> [file2] ..."
        log ""
        log "🌟 MUNFAQQIHA's proven TeraBox uploader"
        log "Environment variables:"
        log "  TERABOX_JSTOKEN (required)"
        log "  TERABOX_COOKIE (required)"  
        log "  TERABOX_BDSTOKEN (optional but recommended)"
        log "  TERABOX_REMOTE_FOLDER (optional, default: /rtsp-videos)"
        log ""
        log "Features:"
        log "  ✅ Auto token refresh"
        log "  ✅ Large file splitting (>2GB)"
        log "  ✅ Quota and VIP checking"
        log "  ✅ Proven success on Linux/Windows"
        exit 1
    fi
    
    if ! check_config; then
        exit 1
    fi
    
    # Check dependencies
    if ! command -v jq >/dev/null 2>&1; then
        log "❌ ERROR: jq is required but not installed"
        log "Install: sudo apt-get install jq"
        exit 1
    fi
    
    log "🚀 Starting TeraBox upload using MUNFAQQIHA's method"
    log "📂 Target folder: $rf"
    
    local success_count=0
    local total_count=$#
    
    for file in "$@"; do
        log ""
        log "📄 Processing file $((success_count + 1))/$total_count: $(basename "$file")"
        
        if upload_file "$file"; then
            success_count=$((success_count + 1))
            log "✅ Upload completed successfully"
        else
            log "❌ Upload failed"
        fi
    done
    
    log ""
    if [[ $success_count -eq $total_count ]]; then
        log "📊 Upload Summary: $success_count/$total_count files uploaded successfully"
        log "🎉 All uploads completed successfully!"
        exit 0
    else
        local failed_count=$((total_count - success_count))
        log "📊 Upload Summary: $success_count succeeded, $failed_count failed (total: $total_count files)"
        log "⚠️  Some uploads failed. Check logs above for details."
        exit 1
    fi
}

# Run main function with all arguments
main "$@"
