import requests
import time
import sys

# --- Configuration ---
BASE_URL = "https://linkedin-pinpoint-worker.gdgdughdshf.workers.dev"
SECRET_KEY = "BloggingIo@7" # Your secret key
START_NUM = 474
END_NUM = 460

def bulk_add():
    print(f"🚀 Starting Reliable Bulk Add: {START_NUM} down to {END_NUM}")
    print(f"📍 Base URL: {BASE_URL}")
    print("-" * 50)

    success_list = []
    failed_attempts = {} # number: count

    # Determine numbers to process
    numbers = range(START_NUM, END_NUM - 1, -1)
    
    for number in numbers:
        success = False
        print(f"🔄 Processing Pinpoint #{number}...", end="", flush=True)
        
        while not success:
            url = f"{BASE_URL}/add/{number}/{SECRET_KEY}"
            try:
                response = requests.get(url, timeout=45)
                data = response.json()
                
                if response.status_code == 200 and data.get("success"):
                    print(f" ✅ Success!")
                    success_list.append(number)
                    success = True
                    # Wait 10 seconds before next request after success
                    if number != END_NUM:
                        print("    (Waiting 10 seconds before next...)")
                        time.sleep(10)
                else:
                    error_msg = data.get("message") or data.get("error") or "Unknown error"
                    print(f" ❌ Failed!")
                    print(f"    Reason: {error_msg}")
                    failed_attempts[number] = failed_attempts.get(number, 0) + 1
                    print("    (Waiting 1 minute before retrying...)")
                    time.sleep(60)
                    print(f"🔄 Retrying Pinpoint #{number} (Attempt {failed_attempts[number] + 1})...", end="", flush=True)
                    
            except Exception as e:
                print(f" ⚠️ Error: {str(e)}")
                failed_attempts[number] = failed_attempts.get(number, 0) + 1
                print("    (Waiting 1 minute before retrying...)")
                time.sleep(60)
                print(f"🔄 Retrying Pinpoint #{number} (Attempt {failed_attempts[number] + 1})...", end="", flush=True)

    print("-" * 50)
    print("🏁 Bulk Add Completed!")
    print(f"✅ Total Successful: {len(success_list)}")
    print(f"❌ Failed Numbers (at least once): {len(failed_attempts)}")
    
    if failed_attempts:
        print("\nDetailed Failures (Retry Count):")
        for num, count in failed_attempts.items():
            print(f" - #{num}: {count} retries before success (or currently pending)")
    
    print("-" * 50)

if __name__ == "__main__":
    try:
        bulk_add()
    except KeyboardInterrupt:
        print("\n\n🛑 Process manually stopped by user.")
        sys.exit(0)
