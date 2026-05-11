import asyncio
import aiohttp
import time

# --- Configuration ---
# Your Worker URL
BASE_URL = "https://linkedin-pinpoint-worker.gdgdughdshf.workers.dev"
# The secret key set in Cloudflare Workers
SECRET_KEY = "BloggingIo@7"
# Pinpoint range to add
START_NUM = 607
END_NUM = 460
# Number of concurrent requests to allow (to avoid rate limits or worker timeouts)
CONCURRENCY_LIMIT = 5 

async def add_pinpoint(session, number, semaphore):
    """Adds a single pinpoint using the worker API."""
    url = f"{BASE_URL}/add/{number}/{SECRET_KEY}"
    
    async with semaphore:
        try:
            async with session.get(url, timeout=30) as response:
                status = response.status
                data = await response.json()
                
                if status == 200 and data.get("success"):
                    print(f"[✓] Pinpoint #{number}: Success - {data['data']['answer'][:40]}...")
                    return True
                else:
                    error_msg = data.get("message") or data.get("error") or "Unknown error"
                    print(f"[✗] Pinpoint #{number}: Failed ({status}) - {error_msg}")
                    return False
        except Exception as e:
            print(f"[!] Pinpoint #{number}: Error - {str(e)}")
            return False

async def main():
    print("🚀 Starting Bulk Add Process")
    print(f"📍 Target: {BASE_URL}")
    print(f"🔢 Range: {START_NUM} down to {END_NUM}")
    print(f"⚡ Concurrency: {CONCURRENCY_LIMIT}")
    print("-" * 50)

    start_time = time.time()
    
    # Create the range of numbers (descending)
    numbers = range(START_NUM, END_NUM - 1, -1)
    
    semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)
    
    async with aiohttp.ClientSession() as session:
        tasks = [add_pinpoint(session, num, semaphore) for num in numbers]
        results = await asyncio.gather(*tasks)
    
    end_time = time.time()
    total_time = end_time - start_time
    success_count = sum(1 for r in results if r)
    fail_count = len(results) - success_count

    print("-" * 50)
    print(f"🏁 Bulk Add Finished!")
    print(f"✅ Successful: {success_count}")
    print(f"❌ Failed:     {fail_count}")
    print(f"⏱️ Total Time: {total_time:.2f} seconds")
    print(f"📊 Average:    {total_time/len(numbers):.2f}s per request")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Process interrupted by user.")
    except Exception as e:
        print(f"\n☢️ Critical Error: {e}")
