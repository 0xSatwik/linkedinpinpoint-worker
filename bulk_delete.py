import asyncio
import aiohttp
import time

# --- Configuration ---
# Your Worker URL
BASE_URL = "https://linkedin-pinpoint-worker.gdgdughdshf.workers.dev"
# The secret key set in Cloudflare Workers
SECRET_KEY = "BloggingIo@7"
# Number of concurrent requests to allow
CONCURRENCY_LIMIT = 10

async def delete_pinpoint(session, number, semaphore):
    """Deletes a single pinpoint using the worker API."""
    url = f"{BASE_URL}/delete/{number}/{SECRET_KEY}"
    
    async with semaphore:
        try:
            async with session.get(url, timeout=30) as response:
                status = response.status
                data = await response.json()
                
                if status == 200 and data.get("success"):
                    print(f"[✓] Pinpoint #{number}: Deleted successfully")
                    return True
                elif status == 404:
                    print(f"[·] Pinpoint #{number}: Not found (already deleted or never existed)")
                    return True  # Count as success since it's not in DB
                else:
                    error_msg = data.get("message") or data.get("error") or "Unknown error"
                    print(f"[✗] Pinpoint #{number}: Failed ({status}) - {error_msg}")
                    return False
        except Exception as e:
            print(f"[!] Pinpoint #{number}: Error - {str(e)}")
            return False

async def get_all_numbers():
    """Fetch all pinpoint numbers from the database."""
    print("📊 Fetching all pinpoint numbers from database...")
    
    try:
        async with aiohttp.ClientSession() as session:
            # Use a high limit and page through to get all
            all_numbers = []
            page = 1
            
            while True:
                url = f"{BASE_URL}/last/20/{page}"
                async with session.get(url, timeout=30) as response:
                    if response.status == 200:
                        data = await response.json()
                        if data.get("success") and data.get("data"):
                            numbers = [item["number"] for item in data["data"]]
                            all_numbers.extend(numbers)
                            print(f"   Page {page}: Found {len(numbers)} entries")
                            
                            # If we got less than 20, we're on the last page
                            if len(numbers) < 20:
                                break
                            page += 1
                        else:
                            break
                    else:
                        break
            
            print(f"✅ Total entries found: {len(all_numbers)}")
            return all_numbers
    except Exception as e:
        print(f"❌ Error fetching numbers: {e}")
        return []

async def main():
    print("🗑️  Starting Bulk Delete Process")
    print(f"📍 Target: {BASE_URL}")
    print("-" * 50)

    # Get all numbers from the database
    numbers = await get_all_numbers()
    
    if not numbers:
        print("⚠️  No entries found in database. Nothing to delete.")
        return

    print(f"\n⚠️  WARNING: About to delete {len(numbers)} entries!")
    print(f"Range: #{min(numbers)} to #{max(numbers)}")
    
    # Ask for confirmation
    try:
        user_input = input("\n❓ Are you sure you want to delete ALL data? (yes/no): ")
        if user_input.lower() not in ['yes', 'y']:
            print("❌ Deletion cancelled by user.")
            return
    except KeyboardInterrupt:
        print("\n❌ Deletion cancelled by user.")
        return

    print("\n🚀 Starting deletion...")
    print("-" * 50)

    start_time = time.time()
    
    semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)
    
    async with aiohttp.ClientSession() as session:
        tasks = [delete_pinpoint(session, num, semaphore) for num in numbers]
        results = await asyncio.gather(*tasks)
    
    end_time = time.time()
    total_time = end_time - start_time
    success_count = sum(1 for r in results if r)
    fail_count = len(results) - success_count

    print("-" * 50)
    print(f"🏁 Bulk Delete Finished!")
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
